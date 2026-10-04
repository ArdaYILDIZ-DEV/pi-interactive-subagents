import { it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension, { type RunningSubagent } from "../../pi-extension/subagents/index.ts";
import { attachSubagentWatcher, stopDispatcherTimers } from "../../pi-extension/subagents/lifecycle/dispatcher.ts";
import { resumeSubagent } from "../../pi-extension/subagents/lifecycle/resume.ts";
import type { LaunchContext } from "../../pi-extension/subagents/lifecycle/launch.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function completedChild(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "iss-lifecycle-"));
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "child-id" }) + "\n");
  writeFileSync(`${sessionFile}.done`, JSON.stringify({ type: "done" }));
  const running: RunningSubagent = {
    id: "child", name: "worker", task: "test", surface: "%test-only",
    startTime: Date.now(), sessionFile, interactive: false,
  };
  const savedTmux = process.env.TMUX;
  delete process.env.TMUX;
  t.after(() => {
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    stopDispatcherTimers();
    rmSync(dir, { recursive: true, force: true });
  });
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (text: string) => { diagnostics.push(text); return true; });
  return { running, diagnostics };
}

it("dispatches an active completion exactly once", async (t) => {
  const { running } = completedChild(t);
  let sent = 0;
  let completed = 0;
  let refreshed = 0;
  const pi = { sendMessage() { sent++; } } as unknown as ExtensionAPI;
  const map = new Map([[running.id, running]]);
  attachSubagentWatcher(running, pi, {
    runningSubagents: map,
    getPi: () => pi,
    updateWidget() { refreshed++; },
  }, { onCompleted() { completed++; } });
  await flush();
  assert.equal(sent, 1);
  assert.equal(completed, 1);
  assert.equal(refreshed, 1);
  assert.equal(map.size, 0);
});

for (const replacement of ["shutdown", "replacement", "abort"] as const) {
  it(`suppresses late completion callbacks after ${replacement}`, async (t) => {
    const { running } = completedChild(t);
    let sent = 0;
    let completed = 0;
    let refreshed = 0;
    const pi = { sendMessage() { sent++; } } as unknown as ExtensionAPI;
    let livePi: ExtensionAPI | null = pi;
    const map = new Map([[running.id, running]]);
    attachSubagentWatcher(running, pi, {
      runningSubagents: map,
      getPi: () => livePi,
      updateWidget() { refreshed++; },
    }, { onCompleted() { completed++; } });
    if (replacement === "shutdown") livePi = null;
    else if (replacement === "replacement") livePi = {} as ExtensionAPI;
    else running.abortController!.abort();
    await flush();
    assert.equal(sent, 0);
    assert.equal(completed, 0);
    assert.equal(refreshed, 0);
    assert.equal(map.size, 0);
  });
}

it("does not turn a failed result delivery into a second result delivery", async (t) => {
  const { running, diagnostics } = completedChild(t);
  let sent = 0;
  let completed = 0;
  let refreshed = 0;
  const pi = {
    sendMessage() {
      sent++;
      if (sent === 1) throw new Error("stale host");
    },
  } as unknown as ExtensionAPI;
  attachSubagentWatcher(running, pi, {
    runningSubagents: new Map([[running.id, running]]),
    getPi: () => pi,
    updateWidget() { refreshed++; },
  }, { onCompleted() { completed++; } });
  await flush();
  assert.equal(sent, 1);
  assert.equal(completed, 1);
  assert.equal(refreshed, 1);
  assert.match(diagnostics.join(""), /stale host/);
});

it("contains callback failures without repeating completion callbacks", async (t) => {
  const { running, diagnostics } = completedChild(t);
  let completed = 0;
  const pi = { sendMessage() {} } as unknown as ExtensionAPI;
  attachSubagentWatcher(running, pi, {
    runningSubagents: new Map([[running.id, running]]),
    getPi: () => pi,
    updateWidget() {},
  }, { onCompleted() {
    completed++;
    if (completed === 1) throw new Error("completion callback failed");
  } });
  await flush();
  assert.equal(completed, 1);
  assert.match(diagnostics.join(""), /completion callback failed/);
});

it("does not deliver a result when completion teardown invalidates the host", async (t) => {
  const { running } = completedChild(t);
  let sent = 0;
  let refreshed = 0;
  const pi = { sendMessage() { sent++; } } as unknown as ExtensionAPI;
  let livePi: ExtensionAPI | null = pi;
  attachSubagentWatcher(running, pi, {
    runningSubagents: new Map([[running.id, running]]),
    getPi: () => livePi,
    updateWidget() { refreshed++; },
  }, { onCompleted() { livePi = null; } });
  await flush();
  assert.equal(sent, 0);
  assert.equal(refreshed, 0);
});

it("makes runtime shutdown idempotent before watcher microtasks run", async (t) => {
  const { running } = completedChild(t);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  let sent = 0;
  let refreshed = 0;
  let completed = 0;
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void) { handlers.set(name, handler); },
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
    sendMessage() { sent++; },
  } as unknown as ExtensionAPI;
  subagentsExtension(pi);
  const ctx = { hasUI: true, ui: { setWidget() { refreshed++; } } };
  handlers.get("session_start")!({}, ctx);
  const map = new Map([[running.id, running]]);
  attachSubagentWatcher(running, pi, {
    runningSubagents: map,
    getPi: () => pi,
    updateWidget() { refreshed++; },
  }, { onCompleted() { completed++; } });
  // Even a completion already waiting in the microtask queue must obey abort.
  running.abortController!.abort();
  handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
  handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
  await flush();
  assert.equal(sent, 0);
  assert.equal(completed, 0);
  assert.equal(refreshed, 0);
});

it("does not remove a replacement record when an old watcher completes", async (t) => {
  const { running } = completedChild(t);
  const pi = { sendMessage() {} } as unknown as ExtensionAPI;
  const map = new Map([[running.id, running]]);
  attachSubagentWatcher(running, pi, {
    runningSubagents: map, getPi: () => pi, updateWidget() {},
  });
  const replacement = { ...running, sessionFile: "replacement.jsonl" };
  map.set(running.id, replacement);
  running.abortController!.abort();
  await flush();
  assert.equal(map.get(running.id), replacement);
});

it("contains widget failures without retrying the callback or delivery", async (t) => {
  const { running, diagnostics } = completedChild(t);
  let sent = 0;
  let refreshed = 0;
  let completed = 0;
  const pi = { sendMessage() { sent++; } } as unknown as ExtensionAPI;
  attachSubagentWatcher(running, pi, {
    runningSubagents: new Map([[running.id, running]]), getPi: () => pi,
    updateWidget() {
      refreshed++;
      if (refreshed === 1) throw new Error("disposed widget");
    },
  }, { onCompleted() { completed++; } });
  await flush();
  assert.equal(sent, 0);
  assert.equal(refreshed, 1);
  assert.equal(completed, 1);
  assert.match(diagnostics.join(""), /disposed widget/);
});

it("refuses invalid resume snapshots before touching session APIs or panes", (t) => {
  const { running } = completedChild(t);
  writeFileSync(`${running.sessionFile}.loadout.json`, "{}");
  const ctx: LaunchContext = {
    cwd: "/tmp",
    sessionManager: {
      getSessionId() { throw new Error("must not touch session API"); },
      getSessionDir() { throw new Error("must not touch session API"); },
      getSessionFile() { throw new Error("must not touch session API"); },
    },
  };
  const map = new Map<string, RunningSubagent>();
  const result = resumeSubagent("worker", "next task", {
    sessionFile: running.sessionFile, sessionId: "child-id",
  }, "unused", ctx, {} as ExtensionAPI, map, {
    getPi: () => null,
    updateWidget() { throw new Error("must not refresh widgets"); },
  });
  assert.match(result.details.error ?? "", /snapshot is missing or invalid/);
  assert.match(result.content[0].text, /restrictions cannot be verified/);
  assert.equal(map.size, 0);
});
