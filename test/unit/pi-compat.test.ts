import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SESSION_VERSION, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import registerSubagents from "../../pi-extension/subagents/index.ts";
import registerDone from "../../pi-extension/subagents/subagent-done.ts";
import registerSafeBash from "../../pi-extension/subagents/tools/safe-bash.ts";
import { seedSubagentSessionFile, findLastAssistantMessage } from "../../pi-extension/subagents/session.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

it("declares the Pi 1.x support boundary and uses the public TypeBox package", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "^1.0.1");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "^1.0.1");
  assert.equal(manifest.peerDependencies.typebox, "^1.3.27");
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "1.0.1");
  assert.equal(manifest.devDependencies["@earendil-works/pi-tui"], "1.0.1");
  assert.equal(manifest.devDependencies.typebox, "1.3.27");
  assert.equal(manifest.peerDependencies["@sinclair/typebox"], undefined);
  assert.equal(manifest.devDependencies["@sinclair/typebox"], undefined);
});

it("does not depend on legacy schema aliases or deep Pi module imports", () => {
  function inspect(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) inspect(path);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        assert.doesNotMatch(source, /["']@sinclair\/typebox(?:\/[^"']*)?["']/,
          `legacy TypeBox alias in ${path}`);
        assert.doesNotMatch(source, /["']@earendil-works\/pi-(?:coding-agent|tui)\/[^"']+["']/,
          `deep Pi import in ${path}`);
      }
    }
  }
  inspect(join(root, "pi-extension/subagents"));
});

it("registers all tools with schemas validated by public TypeBox 1.x", () => {
  const schemas = new Map<string, TSchema>();
  const pi = {
    on() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    sendMessage() {}, sendUserMessage() {}, getAllTools() { return []; },
    registerTool(tool: { name: string; parameters: TSchema }) { schemas.set(tool.name, tool.parameters); },
  } as unknown as ExtensionAPI;
  registerSubagents(pi);
  registerDone(pi);
  registerSafeBash(pi);
  const cases: Array<[string, unknown, unknown]> = [
    ["subagent", { agent: "scout", task: "inspect" }, { agent: "scout" }],
    ["subagents_list", {}, "not an object"],
    ["subagent_message", { name: "scout", message: "continue" }, { name: "scout" }],
    ["ask_question", { question: "Which option?" }, { question: 7 }],
    ["safe_bash", { command: "echo test", timeout: 1 }, { command: 7 }],
  ];
  for (const [name, valid, invalid] of cases) {
    assert.ok(schemas.has(name), `tool not registered: ${name}`);
    const validator = Compile(schemas.get(name)!);
    assert.equal(validator.Check(valid), true, `valid arguments rejected: ${name}`);
    assert.equal(validator.Check(invalid), false, `invalid arguments accepted: ${name}`);
  }
});

it("locks the tested host and schema versions consistently with the manifest", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(lock.packages[`node_modules/${name}`].version, manifest.devDependencies[name]);
  }
  assert.equal(lock.packages["node_modules/@sinclair/typebox"], undefined);
});

it("creates child headers and filenames through the public session manager", async (t) => {
  const { createPiSubagentSession } = await import("../../pi-extension/subagents/pi-compat.ts");
  const dir = mkdtempSync(join(tmpdir(), "iss-pi-seed-"));
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });
  const parent = join(dir, "parent.jsonl");
  const child = createPiSubagentSession(dir, dir, parent);
  assert.equal(existsSync(child.sessionFile), false, "public session creation is lazy");
  seedSubagentSessionFile({
    parentSessionFile: parent, childSessionFile: child.sessionFile, childCwd: dir,
    header: child.header,
  });
  const opened = SessionManager.open(child.sessionFile);
  assert.equal(opened.getHeader()!.version, CURRENT_SESSION_VERSION);
  assert.equal(opened.getHeader()!.parentSession, parent);
  assert.equal(opened.getSessionId(), child.header.id);
  assert.equal(opened.getSessionDir(), SessionManager.create(dir).getSessionDir());
});

for (const version of [undefined, 1, 2, 3]) {
  it(`reads legacy session version ${String(version)} without rewriting the file`, async (t) => {
    const { readPiSessionSnapshot } = await import("../../pi-extension/subagents/pi-compat.ts");
    const dir = mkdtempSync(join(tmpdir(), "iss-pi-legacy-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "legacy.jsonl");
    const header = { type: "session", version, id: "legacy-id", cwd: dir, timestamp: "2026-01-01T00:00:00Z" };
    const linear = version === undefined || version === 1;
    const entries = [
      header,
      { type: "message", ...(linear ? {} : { id: "user", parentId: null }),
        timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "inspect" } },
      { type: "message", ...(linear ? {} : { id: "assistant", parentId: "user" }),
        timestamp: "2026-01-01T00:00:02Z", message: {
          role: "assistant", content: [{ type: "text", text: "legacy result" }], stopReason: "stop",
        } },
    ];
    const original = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(file, original);
    const snapshot = readPiSessionSnapshot(file);
    assert.equal(snapshot.sessionId, "legacy-id");
    assert.equal(findLastAssistantMessage(snapshot.branch), "legacy result");
    assert.equal(readFileSync(file, "utf8"), original);
  });
}

it("uses the public active branch rather than the last physical assistant record", async (t) => {
  const { readPiSessionSnapshot } = await import("../../pi-extension/subagents/pi-compat.ts");
  const dir = mkdtempSync(join(tmpdir(), "iss-pi-branch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "branch.jsonl");
  const entries = [
    { type: "session", version: 3, id: "branch-id", cwd: dir, timestamp: "2026-01-01T00:00:00Z" },
    { type: "message", id: "user", parentId: null, message: { role: "user", content: "inspect" } },
    { type: "message", id: "active", parentId: "user", message: { role: "assistant", content: [{ type: "text", text: "active result" }] } },
    { type: "message", id: "abandoned", parentId: "user", message: { role: "assistant", content: [{ type: "text", text: "abandoned result" }] } },
    { type: "model_change", id: "leaf", parentId: "active", provider: "test", modelId: "test" },
  ];
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const snapshot = readPiSessionSnapshot(file);
  assert.equal(findLastAssistantMessage(snapshot.branch), "active result");
  assert.equal(snapshot.entries.length, 4);
});

it("rejects unsupported session versions and malformed headers explicitly", async (t) => {
  const { readPiSessionSnapshot } = await import("../../pi-extension/subagents/pi-compat.ts");
  const dir = mkdtempSync(join(tmpdir(), "iss-pi-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "invalid.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION + 1, id: "future", cwd: dir }));
  assert.throws(() => readPiSessionSnapshot(file), /unsupported.*session version/i);
  writeFileSync(file, JSON.stringify({ type: "session", id: 7 }));
  assert.throws(() => readPiSessionSnapshot(file), /session header/i);
});

it("reports missing public host methods and incompatible context returns", async () => {
  const { assertPiExtensionApi, readPiParentSession } = await import("../../pi-extension/subagents/pi-compat.ts");
  assert.throws(() => assertPiExtensionApi({}, "orchestrator"), /ExtensionAPI\.on/);
  assert.throws(() => readPiParentSession({ cwd: "/tmp", sessionManager: {} }), /sessionManager\.getSessionFile/);
  assert.throws(() => readPiParentSession({ cwd: "/tmp", sessionManager: {
    getSessionFile: () => false, getSessionDir: () => "/tmp", getSessionId: () => "test",
  } }), /getSessionFile/);
  const context = { cwd: "/tmp", sessionManager: {
    getSessionFile: () => undefined, getSessionDir: () => "/tmp", getSessionId: () => "test",
  } };
  assert.equal(readPiParentSession(context).sessionFile, undefined);
});

it("rejects hosts outside the supported major-version boundary", async () => {
  const { __test__ } = await import("../../pi-extension/subagents/pi-compat.ts");
  for (const version of [undefined, "unknown", "0.84.3", "1.0.0", "2.0.0", "1.1.0-beta.1"]) {
    assert.throws(() => __test__.assertSupportedPiVersion(version), /Unsupported host version/);
  }
  for (const version of ["1.0.1", "1.1.0", "1.0.1+build.1", "1.0.1+build-1"]) {
    assert.doesNotThrow(() => __test__.assertSupportedPiVersion(version));
  }
});

it("accepts the public in-memory session context without misreporting incompatibility", async () => {
  const { readPiParentSession } = await import("../../pi-extension/subagents/pi-compat.ts");
  const parent = readPiParentSession({ cwd: "/tmp", sessionManager: SessionManager.inMemory("/tmp") });
  assert.equal(parent.sessionFile, undefined);
  assert.equal(parent.sessionDir, "");
});
