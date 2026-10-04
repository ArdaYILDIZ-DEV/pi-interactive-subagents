import { it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerDone from "../../pi-extension/subagents/subagent-done.ts";
import { publishRunningChildrenCount, resetRunningChildrenCountForTests } from "../../pi-extension/subagents/registry.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => void;

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "iss-done-"));
  const session = join(dir, "child.jsonl");
  const savedEnv = { ...process.env };
  process.env.PI_SUBAGENT_SESSION = session;
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  process.env.PI_SUBAGENT_SETTLE_TIMEOUT_MS = "30000";
  process.env.PI_SUBAGENT_SHUTDOWN_TIMEOUT_MS = "10000";
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  resetRunningChildrenCountForTests();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const exits: Array<number | undefined> = [];
  t.mock.method(process, "exit", (code?: number) => { exits.push(code); });
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (text: string) => { diagnostics.push(text); return true; });
  const handlers = new Map<string, Handler>();
  let askQuestion: ((id: string, params: { question: string }) => Promise<unknown>) | undefined;
  let shutdowns = 0;
  let shutdownError = false;
  const ctx = {
    hasUI: false,
    ui: { setWidget() {} },
    shutdown() {
      shutdowns++;
      if (shutdownError) throw new Error("shutdown failed");
    },
  };
  registerDone({
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    getAllTools() { return []; },
    registerShortcut() {},
    registerTool(tool: { execute: typeof askQuestion }) { askQuestion = tool.execute; },
  } as unknown as ExtensionAPI);
  function emit(name: string, event: Record<string, unknown> = {}) {
    assert.ok(handlers.has(name), `missing handler: ${name}`);
    handlers.get(name)!(event, ctx);
  }
  t.after(() => {
    emit("session_shutdown");
    resetRunningChildrenCountForTests();
    process.env = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });
  const messages = [{ role: "assistant", stopReason: "stop" }];
  return {
    dir, session, emit, messages, exits, diagnostics,
    shutdowns: () => shutdowns,
    failShutdown: () => { shutdownError = true; },
    ask: () => askQuestion!("ask-1", { question: "Which option?" }),
  };
}

it("waits for settlement before reporting completion or shutting down", (t) => {
  const h = setup(t);
  h.emit("agent_end", { messages: h.messages });
  assert.equal(h.shutdowns(), 0);
  assert.equal(existsSync(`${h.session}.done`), false);
  h.emit("agent_settled");
  assert.equal(h.shutdowns(), 1);
  assert.equal(existsSync(`${h.session}.done`), true);
  t.mock.timers.tick(100);
  assert.deepEqual(h.exits, [], "must not force exit after 100ms");
  h.emit("session_shutdown");
  t.mock.timers.tick(30000);
  assert.deepEqual(h.exits, [], "orderly shutdown cancels safety timers");
});

it("clears the settlement deadline when automatic continuation starts", (t) => {
  const h = setup(t);
  h.emit("agent_end", { messages: h.messages });
  t.mock.timers.tick(20000);
  h.emit("agent_start");
  h.emit("turn_start");
  t.mock.timers.tick(30000);
  assert.equal(h.shutdowns(), 0);
  assert.deepEqual(h.exits, []);
  h.emit("agent_end", { messages: h.messages });
  h.emit("agent_settled");
  assert.equal(h.shutdowns(), 1);
});

it("reports an error and exits nonzero if settlement never arrives", (t) => {
  const h = setup(t);
  h.emit("agent_end", { messages: h.messages });
  t.mock.timers.tick(30000);
  assert.equal(existsSync(`${h.session}.done`), false);
  const error = JSON.parse(readFileSync(`${h.session}.exit`, "utf8"));
  assert.equal(error.type, "error");
  assert.match(error.errorMessage, /agent_settled.*30000/);
  assert.equal(h.shutdowns(), 1);
  assert.deepEqual(h.exits, [1]);
  assert.match(h.diagnostics.join(""), /agent_settled/);
});

it("bounds shutdown after settlement and preserves an explicit failure", (t) => {
  const h = setup(t);
  h.emit("agent_end", { messages: h.messages });
  h.emit("agent_settled");
  t.mock.timers.tick(10000);
  assert.deepEqual(h.exits, [1]);
  assert.equal(existsSync(`${h.session}.done`), false);
  const error = JSON.parse(readFileSync(`${h.session}.exit`, "utf8"));
  assert.match(error.errorMessage, /shutdown/);
});

it("does not auto-exit an aborted turn or a parent with running children", (t) => {
  const h = setup(t);
  h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
  h.emit("agent_settled");
  t.mock.timers.tick(30000);
  assert.equal(h.shutdowns(), 0);
  publishRunningChildrenCount(() => 1);
  h.emit("agent_end", { messages: h.messages });
  h.emit("agent_settled");
  t.mock.timers.tick(30000);
  assert.equal(h.shutdowns(), 0);
  assert.deepEqual(h.exits, []);
});

it("preserves interactive auto-exit opt-out", (t) => {
  const h = setup(t);
  process.env.PI_SUBAGENT_AUTO_EXIT = "0";
  h.emit("agent_end", { messages: h.messages });
  h.emit("agent_settled");
  t.mock.timers.tick(30000);
  assert.equal(h.shutdowns(), 0);
  assert.deepEqual(h.exits, []);
});

it("rejects missing or unknown final assistant state instead of reporting success", (t) => {
  const h = setup(t);
  h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "future-value" }] });
  h.emit("agent_settled");
  assert.equal(existsSync(`${h.session}.done`), false);
  const error = JSON.parse(readFileSync(`${h.session}.exit`, "utf8"));
  assert.match(error.errorMessage, /assistant|stopReason/);
});

it("handles malformed agent_end payloads as explicit compatibility errors", (t) => {
  const h = setup(t);
  h.emit("agent_end", { messages: { unexpected: true } });
  h.emit("agent_settled");
  assert.equal(existsSync(`${h.session}.done`), false);
  const error = JSON.parse(readFileSync(`${h.session}.exit`, "utf8"));
  assert.match(error.errorMessage, /assistant|messages/);
});

it("reports the final provider error without writing a success sidecar", (t) => {
  const h = setup(t);
  h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider unavailable" }] });
  assert.equal(h.shutdowns(), 0);
  h.emit("agent_settled");
  const error = JSON.parse(readFileSync(`${h.session}.exit`, "utf8"));
  assert.equal(error.errorMessage, "provider unavailable");
  assert.equal(existsSync(`${h.session}.done`), false);
});

it("keeps a child open while an orchestrator answer is pending", async (t) => {
  const h = setup(t);
  await h.ask();
  h.emit("agent_end", { messages: h.messages });
  h.emit("agent_settled");
  t.mock.timers.tick(30000);
  assert.equal(h.shutdowns(), 0);
  assert.deepEqual(h.exits, []);
  assert.equal(existsSync(`${h.session}.done`), false);
});

it("reports missing assistant messages at settlement as an error", (t) => {
  const h = setup(t);
  h.emit("agent_end", { messages: [] });
  h.emit("agent_settled");
  assert.equal(existsSync(`${h.session}.done`), false);
  const error = JSON.parse(readFileSync(`${h.session}.exit`, "utf8"));
  assert.match(error.errorMessage, /no final assistant/);
});

it("exits explicitly when the orderly shutdown request throws", (t) => {
  const h = setup(t);
  h.failShutdown();
  h.emit("agent_end", { messages: h.messages });
  h.emit("agent_settled");
  assert.deepEqual(h.exits, [1]);
  assert.equal(existsSync(`${h.session}.done`), false);
  assert.match(h.diagnostics.join(""), /shutdown failed/);
  t.mock.timers.tick(30000);
  assert.deepEqual(h.exits, [1], "failure must not leave a second safety exit armed");
});

it("does not claim question delivery or remain waiting after sidecar write failure", async (t) => {
  const h = setup(t);
  mkdirSync(`${h.session}.ask`);
  await assert.rejects(h.ask(), /Failed to send subagent question/);
  h.emit("agent_end", { messages: h.messages });
  h.emit("agent_settled");
  assert.equal(h.shutdowns(), 1, "failed question writes must not leave awaitingAnswer set");
  assert.equal(readdirSync(h.dir).some((name) => name.includes(".tmp-")), false);
});

it("reports completion sidecar write failures explicitly and exits nonzero", (t) => {
  const h = setup(t);
  rmSync(h.dir, { recursive: true, force: true });
  h.emit("agent_end", { messages: h.messages });
  h.emit("agent_settled");
  assert.deepEqual(h.exits, [1]);
  assert.match(h.diagnostics.join(""), /completion sidecar/);
});

it("writes complete question and completion payloads without leftover temporary files", async (t) => {
  const h = setup(t);
  await h.ask();
  assert.equal(JSON.parse(readFileSync(`${h.session}.ask`, "utf8")).question, "Which option?");
  h.emit("input");
  h.emit("agent_end", { messages: h.messages });
  h.emit("agent_settled");
  assert.equal(JSON.parse(readFileSync(`${h.session}.done`, "utf8")).type, "done");
  assert.equal(readdirSync(h.dir).some((name) => name.includes(".tmp-")), false);
});

it("reports missing child APIs at startup and exits instead of hanging", (t) => {
  const h = setup(t);
  registerDone({} as ExtensionAPI);
  assert.deepEqual(h.exits, [1]);
  const error = JSON.parse(readFileSync(`${h.session}.exit`, "utf8"));
  assert.match(error.errorMessage, /ExtensionAPI\.on/);
  assert.match(h.diagnostics.join(""), /startup failed/);
});

it("degrades missing UI helpers without disabling completion supervision", (t) => {
  const h = setup(t);
  const handlers = new Map<string, Handler>();
  registerDone({
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerTool() {},
  } as unknown as ExtensionAPI);
  let shutdowns = 0;
  const ctx = {
    hasUI: true, mode: "rpc",
    ui: { setWidget() { throw new Error("terminal widgets are not supported in RPC"); } },
    shutdown() { shutdowns++; handlers.get("session_shutdown")!({}, ctx); },
  };
  handlers.get("session_start")!({}, ctx);
  handlers.get("agent_end")!({ messages: h.messages }, ctx);
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(shutdowns, 1);
  assert.equal(JSON.parse(readFileSync(`${h.session}.done`, "utf8")).type, "done");
  assert.match(h.diagnostics.join(""), /UI helpers are unavailable/);
  assert.deepEqual(h.exits, []);
});
