import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSessionId,
  seedSubagentSessionFile,
  writeSubagentLoadout,
  readSubagentLoadout,
  loadoutSidecarPath,
  nameRegistryPath,
  readNameRegistry,
  registerName,
  resolveNameInRegistry,
  getNewEntries,
  countSessionEntryLines,
  findLastAssistantMessage,
  summarizeSessionStats,
  type SubagentLoadout,
  type SessionEntry,
} from "../../pi-extension/subagents/session.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "iss-session-"));
}

const ASSISTANT = {
  type: "message",
  id: "a1",
  parentId: "u1",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
};
const ASSISTANT_ERROR = {
  type: "message",
  id: "a2",
  parentId: "u1",
  message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overload" },
};

describe("session.ts", () => {
  it("reads the canonical session id from the first line", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    writeFileSync(f, JSON.stringify({ type: "session", id: "sess-xyz", version: 3 }) + "\n");
    assert.equal(getSessionId(f), "sess-xyz");
    rmSync(d, { recursive: true, force: true });
  });

  it("returns null for a missing or non-session file", () => {
    assert.equal(getSessionId("/no/such/file.jsonl"), null);
    const d = tmp();
    const f = join(d, "s.jsonl");
    writeFileSync(f, JSON.stringify({ type: "message", id: "x" }) + "\n");
    assert.equal(getSessionId(f), null);
    rmSync(d, { recursive: true, force: true });
  });

  it("seeds a lineage-only child header linked to the parent", () => {
    const d = tmp();
    const parent = join(d, "parent.jsonl");
    const child = join(d, "child.jsonl");
    writeFileSync(parent, JSON.stringify({ type: "session", id: "p", version: 3 }) + "\n");
    seedSubagentSessionFile({ parentSessionFile: parent, childSessionFile: child, childCwd: "/tmp/cwd" });
    const header = JSON.parse(readFileSync(child, "utf8").trim().split("\n")[0]);
    assert.equal(header.type, "session");
    assert.equal(header.parentSession, parent);
    assert.equal(header.cwd, "/tmp/cwd");
    rmSync(d, { recursive: true, force: true });
  });

  it("round-trips a loadout sidecar", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    const loadout: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,ask_question",
      model: "m",
      thinking: "high",
      systemPromptMode: "append",
      identity: "You are a worker.",
      spawnable: ["scout", "researcher"],
      autoExit: true,
      cwd: "/w",
      agentDir: "/agents",
    };
    writeSubagentLoadout(f, loadout);
    assert.equal(loadoutSidecarPath(f), f + ".loadout.json");
    assert.deepEqual(readSubagentLoadout(f), loadout);
    rmSync(d, { recursive: true, force: true });
  });

  it("readSubagentLoadout returns null when missing/corrupt", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    assert.equal(readSubagentLoadout(f), null);
    writeFileSync(f + ".loadout.json", "not json{", "utf8");
    assert.equal(readSubagentLoadout(f), null);
    rmSync(d, { recursive: true, force: true });
  });

  it("registers and resolves names atomically", () => {
    const d = tmp();
    const adir = join(d, "art");
    registerName(adir, "scout", { sessionFile: "/s/scout.jsonl", sessionId: "id-s" });
    assert.deepEqual(resolveNameInRegistry(adir, "scout"), {
      sessionFile: "/s/scout.jsonl",
      sessionId: "id-s",
    });
    assert.ok(existsSync(nameRegistryPath(adir)));
    registerName(adir, "scout", { sessionFile: "/s/scout2.jsonl", sessionId: "id-s2" });
    assert.equal(resolveNameInRegistry(adir, "scout")!.sessionFile, "/s/scout2.jsonl");
    assert.equal(resolveNameInRegistry(adir, "nope"), null);
    rmSync(d, { recursive: true, force: true });
  });

  it("readNameRegistry returns {} on missing/corrupt", () => {
    const d = tmp();
    const adir = join(d, "art");
    assert.deepEqual(readNameRegistry(adir), {});
    rmSync(d, { recursive: true, force: true });
  });

  it("guards name registry against prototype pollution keys", () => {
    const d = tmp();
    const adir = join(d, "art-proto");
    registerName(adir, "__proto__", { sessionFile: "/s/evil.jsonl", sessionId: "evil" });
    registerName(adir, "constructor", { sessionFile: "/s/evil2.jsonl", sessionId: "evil2" });
    registerName(adir, "prototype", { sessionFile: "/s/evil3.jsonl", sessionId: "evil3" });
    assert.equal(resolveNameInRegistry(adir, "__proto__"), null);
    assert.equal(resolveNameInRegistry(adir, "constructor"), null);
    assert.equal(resolveNameInRegistry(adir, "prototype"), null);
    const reg = readNameRegistry(adir);
    assert.equal(Object.keys(reg).length, 0);
    rmSync(d, { recursive: true, force: true });
  });

  it("findLastAssistantMessage prefers text but falls back to errorMessage", () => {
    assert.equal(findLastAssistantMessage([ASSISTANT as any]), "done");
    assert.equal(
      findLastAssistantMessage([ASSISTANT as any, ASSISTANT_ERROR as any]),
      "Subagent error: overload",
    );
    assert.equal(findLastAssistantMessage([]), null);
    // Verify that malformed or null message entries return null safely.
    assert.equal(findLastAssistantMessage([{ type: "message", id: "m0", message: null } as any]), null);
    assert.equal(
      findLastAssistantMessage([
        { type: "message", id: "m1", message: { role: "assistant", content: "not-an-array" } } as any,
      ]),
      null,
    );
  });

  it("countSessionEntryLines matches getNewEntries(0).length", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    writeFileSync(
      f,
      [JSON.stringify({ type: "session", id: "x" }), JSON.stringify(ASSISTANT)].join("\n") + "\n",
    );
    assert.equal(countSessionEntryLines(f), getNewEntries(f, 0).length);
    rmSync(d, { recursive: true, force: true });
  });

  it("getNewEntries gracefully skips corrupted or incomplete lines", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    writeFileSync(
      f,
      [JSON.stringify({ type: "session", id: "x" }), "half-written-json{", JSON.stringify(ASSISTANT)].join("\n") + "\n",
    );
    const entries = getNewEntries(f, 0);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, "x");
    assert.equal(entries[1].id, "a1");
    rmSync(d, { recursive: true, force: true });
  });

  it("getNewEntries handles afterLine offset efficiently without re-parsing skipped lines", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "session", id: "s1" }),
        "",
        "   ",
        JSON.stringify({ type: "message", id: "m1" }),
        JSON.stringify({ type: "message", id: "m2" }),
        JSON.stringify({ type: "message", id: "m3" }),
      ].join("\n") + "\n",
    );
    const from1 = getNewEntries(f, 1);
    assert.equal(from1.length, 3);
    assert.equal(from1[0].id, "m1");
    assert.equal(from1[2].id, "m3");

    const from3 = getNewEntries(f, 3);
    assert.equal(from3.length, 1);
    assert.equal(from3[0].id, "m3");

    const from10 = getNewEntries(f, 10);
    assert.equal(from10.length, 0);
    rmSync(d, { recursive: true, force: true });
  });

  it("summarizes cumulative stats and last context size", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    const rawEntries = [
      { type: "session", id: "x", version: 3 },
      { type: "model_change", id: "mc", modelId: "test-model-x" },
      {
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          model: "test-model-x",
          content: [{ type: "text", text: "ok" }, { type: "toolCall", name: "read" }],
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 200, cost: { total: 0.01 } },
        },
      },
      {
        type: "message",
        id: "a2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok2" }, { type: "toolCall", name: "write" }],
          usage: { input: 30, output: 70, totalTokens: 400, cost: { total: 0.02 } },
        },
      },
    ];

    writeFileSync(
      f,
      rawEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    // Test file-based single-pass summary
    const stats = summarizeSessionStats(f)!;
    assert.equal(stats.model, "test-model-x");
    assert.equal(stats.toolCount, 2);
    assert.equal(stats.inputTokens, 130);
    assert.equal(stats.outputTokens, 120);
    assert.equal(stats.contextTokens, 400);
    assert.ok(Math.abs(stats.cost - 0.03) < 1e-9);

    // Test direct SessionEntry[] in-memory summary (zero redundant disk I/O)
    const directStats = summarizeSessionStats(rawEntries as SessionEntry[])!;
    assert.deepEqual(directStats, stats);

    rmSync(d, { recursive: true, force: true });
  });

  it("handles null-byte paths defensively", () => {
    assert.equal(getSessionId("/tmp/\0evil.jsonl"), null);
    assert.equal(readSubagentLoadout("/tmp/\0evil.jsonl"), null);
    assert.deepEqual(readNameRegistry("/tmp/\0evil"), {});
    assert.equal(resolveNameInRegistry("/tmp/\0evil", "test"), null);
    assert.equal(getNewEntries("/tmp/\0evil.jsonl", 0).length, 0);
    assert.equal(countSessionEntryLines("/tmp/\0evil.jsonl"), 0);
    assert.equal(summarizeSessionStats("/tmp/\0evil.jsonl"), null);
  });
});
