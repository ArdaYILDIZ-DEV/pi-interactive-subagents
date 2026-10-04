import { it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension, { type RunningSubagent } from "../../pi-extension/subagents/index.ts";
import { attachSubagentWatcher, stopDispatcherTimers } from "../../pi-extension/subagents/lifecycle/dispatcher.ts";
import { resumeSubagent } from "../../pi-extension/subagents/lifecycle/resume.ts";
import { launchSubagent, type LaunchContext } from "../../pi-extension/subagents/lifecycle/launch.ts";
import { closeSurface, createSurface, clearCommandAvailabilityCache, stopSurfaceTimers, pollForExit } from "../../pi-extension/subagents/tmux.ts";
import { getArtifactDir, getDefaultSessionDirFor } from "../../pi-extension/subagents/lifecycle/seed.ts";
import { watchSubagent } from "../../pi-extension/subagents/lifecycle/watch.ts";
import { writeSubagentLoadout, type SubagentLoadout } from "../../pi-extension/subagents/session.ts";

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
    sendUserMessage() {},
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

function fakeLaunchEnv(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "iss-launch-"));
  const savedEnv = { ...process.env };
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "tmux.log");
  const alive = join(dir, "pane-alive");
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
printf '%s\\n' "$*" >> "$ISS_FAKE_TMUX_LOG"
case "$1" in
  split-window) touch "$ISS_FAKE_TMUX_ALIVE"; printf '%s\\n' '%iss-test';;
  list-panes) if [ -f "$ISS_FAKE_TMUX_ALIVE" ]; then printf '%s\\n' '%iss-test'; fi;;
  kill-pane) rm -f "$ISS_FAKE_TMUX_ALIVE";;
  capture-pane) printf '%s\\n' "$ISS_FAKE_SCREEN";;
  send-keys) if [ "$ISS_FAKE_FAIL_SEND" = 1 ]; then echo 'test delivery failed' >&2; exit 1; fi;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${savedEnv.PATH ?? ""}`;
  process.env.TMUX = "test-only";
  process.env.TMUX_PANE = "%test-parent";
  process.env.ISS_FAKE_TMUX_LOG = log;
  process.env.ISS_FAKE_TMUX_ALIVE = alive;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "10";
  delete process.env.ISS_FAKE_FAIL_SEND;
  delete process.env.ISS_FAKE_SCREEN;
  clearCommandAvailabilityCache();
  const parent = join(dir, "parent.jsonl");
  writeFileSync(parent, JSON.stringify({ type: "session", id: "parent-id" }) + "\n");
  const ctx: LaunchContext = {
    cwd: "/tmp",
    sessionManager: {
      getSessionFile: () => parent,
      getSessionId: () => "parent-id",
      getSessionDir: () => dir,
    },
  };
  const map = new Map<string, RunningSubagent>();
  const artifactDir = getArtifactDir(dir, "parent-id");
  t.after(() => {
    for (const running of map.values()) {
      running.abortController?.abort();
      closeSurface(running.surface);
    }
    stopDispatcherTimers();
    stopSurfaceTimers();
    clearCommandAvailabilityCache();
    process.env = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });
  function assertNoOrphan() {
    const commands = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
    assert.equal(commands.filter((line) => line.startsWith("split-window ")).length,
      commands.filter((line) => line.startsWith("kill-pane ")).length,
      "every acquired pane must be closed on failure");
    assert.equal(map.size, 0);
  }
  const snapshot: SubagentLoadout = {
    agent: "test", toolAllowlist: "read,ask_question", model: null, thinking: null,
    systemPromptMode: null, identity: null, spawnable: null,
    autoExit: true, cwd: null, agentDir: process.env.PI_CODING_AGENT_DIR!,
  };
  const child = join(dir, "existing-child.jsonl");
  writeFileSync(child, JSON.stringify({ type: "session", id: "old-child" }) + "\n");
  writeSubagentLoadout(child, snapshot);
  const pi = { sendMessage() {} } as unknown as ExtensionAPI;
  const deps = { getPi: () => pi, updateWidget() {} };
  return { dir, ctx, map, artifactDir, child, pi, deps, snapshot, assertNoOrphan };
}

for (const failure of ["activity", "context"] as const) {
  it(`does not leak a launch pane when ${failure} preparation fails`, async (t) => {
    const h = fakeLaunchEnv(t);
    mkdirSync(h.artifactDir, { recursive: true });
    const obstacle = failure === "activity" ? "subagent-activity" : "context";
    writeFileSync(join(h.artifactDir, obstacle), "not a directory");
    await assert.rejects(launchSubagent({ task: "test" }, h.ctx, h.map));
    h.assertNoOrphan();
  });
}

it("does not leak a pane when child session seeding fails", async (t) => {
  const h = fakeLaunchEnv(t);
  const sessionDir = getDefaultSessionDirFor(h.ctx.cwd, process.env.PI_CODING_AGENT_DIR!);
  chmodSync(sessionDir, 0o500);
  t.after(() => { if (existsSync(sessionDir)) chmodSync(sessionDir, 0o700); });
  await assert.rejects(launchSubagent({ task: "test" }, h.ctx, h.map));
  h.assertNoOrphan();
});

it("cleans up a launch pane when command delivery fails", async (t) => {
  const h = fakeLaunchEnv(t);
  process.env.ISS_FAKE_FAIL_SEND = "1";
  await assert.rejects(launchSubagent({ task: "test" }, h.ctx, h.map), /Failed to start subagent/);
  h.assertNoOrphan();
});

it("cancels launch during the shell-ready delay without recording a running child", async (t) => {
  const h = fakeLaunchEnv(t);
  const abort = new AbortController();
  const pending = launchSubagent({ task: "test" }, h.ctx, h.map, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  h.assertNoOrphan();
});

it("refuses launch when the original runtime becomes inactive during the delay", async (t) => {
  const h = fakeLaunchEnv(t);
  let active = true;
  const pending = launchSubagent({ task: "test" }, h.ctx, h.map, { isActive: () => active });
  active = false;
  await assert.rejects(pending, /cancelled/);
  h.assertNoOrphan();
});

it("does not leak a resume pane when prompt preparation fails", (t) => {
  const h = fakeLaunchEnv(t);
  mkdirSync(h.artifactDir, { recursive: true });
  writeFileSync(join(h.artifactDir, "context"), "not a directory");
  writeSubagentLoadout(h.child, { ...h.snapshot, identity: "test identity", systemPromptMode: "append" });
  assert.throws(() => resumeSubagent("test", "follow up", {
    sessionFile: h.child, sessionId: "old-child",
  }, h.artifactDir, h.ctx, h.pi, h.map, h.deps));
  h.assertNoOrphan();
});

it("cleans up a resume pane when command delivery fails", (t) => {
  const h = fakeLaunchEnv(t);
  process.env.ISS_FAKE_FAIL_SEND = "1";
  assert.throws(() => resumeSubagent("test", "follow up", {
    sessionFile: h.child, sessionId: "old-child",
  }, h.artifactDir, h.ctx, h.pi, h.map, h.deps), /Failed to resume subagent/);
  h.assertNoOrphan();
});

it("cancels pending tmux layout work when the runtime shuts down", (t) => {
  const h = fakeLaunchEnv(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void) { handlers.set(name, handler); },
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
    sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI;
  subagentsExtension(pi);
  createSurface("timer-test");
  handlers.get("session_shutdown")!({ reason: "reload" }, {});
  t.mock.timers.tick(1000);
  const commands = readFileSync(join(h.dir, "tmux.log"), "utf8");
  assert.equal(commands.includes("select-layout"), false);
  closeSurface("%iss-test");
});

it("aborts an in-flight spawn when the extension runtime shuts down", async (t) => {
  const h = fakeLaunchEnv(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const agents = join(process.env.PI_CODING_AGENT_DIR!, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "test.md"), "---\nname: test\ntools: read\n---\n");
  type Execute = (id: string, params: { agent: string; task: string }, signal: AbortSignal | undefined,
    onUpdate: undefined, ctx: LaunchContext) => Promise<unknown>;
  const tools = new Map<string, Execute>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void) { handlers.set(name, handler); },
    registerTool(tool: { name: string; execute: Execute }) { tools.set(tool.name, tool.execute); },
    registerCommand() {}, registerMessageRenderer() {},
    sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI;
  subagentsExtension(pi);
  const pending = tools.get("subagent")!("spawn-1", { agent: "test", task: "test" }, undefined, undefined, h.ctx);
  handlers.get("session_shutdown")!({ reason: "reload" }, {});
  await assert.rejects(pending, /cancelled/);
  h.assertNoOrphan();
  t.mock.timers.tick(1000);
  assert.equal(readFileSync(join(h.dir, "tmux.log"), "utf8").includes("select-layout"), false,
    "late launch cleanup must not schedule fresh layout work after shutdown");
});

it("refuses an already-cancelled resume before creating a pane", (t) => {
  const h = fakeLaunchEnv(t);
  const abort = new AbortController();
  abort.abort();
  assert.throws(() => resumeSubagent("test", "follow up", {
    sessionFile: h.child, sessionId: "old-child",
  }, h.artifactDir, h.ctx, h.pi, h.map, h.deps, { signal: abort.signal }), /cancelled/);
  h.assertNoOrphan();
});

it("reports a lost pane without completion evidence as an unknown failure", async (t) => {
  const h = fakeLaunchEnv(t);
  const result = await pollForExit("%iss-test", new AbortController().signal, {
    interval: 1, sessionFile: h.child,
  });
  assert.equal(result.reason, "error");
  assert.notEqual(result.exitCode, 0);
  assert.match(result.errorMessage ?? "", /completion.*unknown|unknown.*completion/i);
});

for (const suffix of ["done", "exit"] as const) {
  it(`reports malformed .${suffix} sidecars as errors`, async (t) => {
    const h = fakeLaunchEnv(t);
    writeFileSync(`${h.child}.${suffix}`, "{broken");
    const result = await pollForExit("%iss-test", new AbortController().signal, {
      interval: 1, sessionFile: h.child,
    });
    assert.equal(result.reason, "error");
    assert.notEqual(result.exitCode, 0);
    assert.match(result.errorMessage ?? "", /completion sidecar/);
  });
}

it("prefers explicit failure when both completion sidecars exist", async (t) => {
  const h = fakeLaunchEnv(t);
  writeFileSync(`${h.child}.done`, JSON.stringify({ type: "done" }));
  writeFileSync(`${h.child}.exit`, JSON.stringify({ type: "error", errorMessage: "failed shutdown" }));
  const result = await pollForExit("%iss-test", new AbortController().signal, {
    interval: 1, sessionFile: h.child,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "failed shutdown");
});

it("does not silently discard a question when host delivery fails", async (t) => {
  const h = fakeLaunchEnv(t);
  process.env.PI_SUBAGENT_WATCH_TIMEOUT_MS = "3000";
  const surface = createSurface("question-test");
  writeFileSync(`${h.child}.ask`, JSON.stringify({ question: "Which option?" }));
  const pi = { sendMessage() { throw new Error("question delivery failed"); } } as unknown as ExtensionAPI;
  const result = await watchSubagent({
    id: "question-test", name: "test", task: "test", surface,
    sessionFile: h.child, startTime: Date.now(),
  }, new AbortController().signal, { getPi: () => pi, removeRunning() {} });
  assert.match(result.errorMessage ?? "", /question delivery failed/);
  assert.equal(existsSync(`${h.child}.ask`), true, "retain undelivered question for diagnostics");
  h.assertNoOrphan();
});

it("reports malformed question payloads instead of waiting silently", async (t) => {
  const h = fakeLaunchEnv(t);
  process.env.PI_SUBAGENT_WATCH_TIMEOUT_MS = "3000";
  const surface = createSurface("question-test");
  writeFileSync(`${h.child}.ask`, JSON.stringify({ question: 7 }));
  const result = await watchSubagent({
    id: "question-test", name: "test", task: "test", surface,
    sessionFile: h.child, startTime: Date.now(),
  }, new AbortController().signal, { getPi: () => h.pi, removeRunning() {} });
  assert.match(result.errorMessage ?? "", /question sidecar/);
  h.assertNoOrphan();
});

it("clears stale transient sidecars before restarting a finished session", (t) => {
  const h = fakeLaunchEnv(t);
  for (const suffix of ["done", "exit", "ask"]) writeFileSync(`${h.child}.${suffix}`, "stale");
  process.env.ISS_FAKE_FAIL_SEND = "1";
  assert.throws(() => resumeSubagent("test", "follow up", {
    sessionFile: h.child, sessionId: "old-child",
  }, h.artifactDir, h.ctx, h.pi, h.map, h.deps), /Failed to resume subagent/);
  for (const suffix of ["done", "exit", "ask"]) assert.equal(existsSync(`${h.child}.${suffix}`), false);
  h.assertNoOrphan();
});

it("preserves valid completion and terminal exit-code fallback", async (t) => {
  const h = fakeLaunchEnv(t);
  writeFileSync(`${h.child}.done`, JSON.stringify({ type: "done", timestamp: Date.now() }));
  assert.deepEqual(await pollForExit("%iss-test", new AbortController().signal, {
    interval: 1, sessionFile: h.child,
  }), { reason: "done", exitCode: 0 });
  createSurface("sentinel-test");
  process.env.ISS_FAKE_SCREEN = "__SUBAGENT_DONE_7__";
  assert.deepEqual(await pollForExit("%iss-test", new AbortController().signal, {
    interval: 1, sessionFile: h.child,
  }), { reason: "sentinel", exitCode: 7 });
  closeSurface("%iss-test");
  h.assertNoOrphan();
});

it("consumes a question only after successful host delivery", async (t) => {
  const h = fakeLaunchEnv(t);
  const surface = createSurface("question-test");
  writeFileSync(`${h.child}.ask`, JSON.stringify({ question: "Which option?" }));
  let sent = 0;
  const pi = {
    sendMessage(message: { customType: string }) {
      assert.equal(message.customType, "subagent_question");
      sent++;
      writeFileSync(`${h.child}.done`, JSON.stringify({ type: "done" }));
    },
  } as unknown as ExtensionAPI;
  const result = await watchSubagent({
    id: "question-test", name: "test", task: "test", surface,
    sessionFile: h.child, startTime: Date.now(),
  }, new AbortController().signal, { getPi: () => pi, removeRunning() {} });
  assert.equal(sent, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(`${h.child}.ask`), false);
  h.assertNoOrphan();
});
