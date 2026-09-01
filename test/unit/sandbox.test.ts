import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildToolAllowlist,
  applySandboxToParts,
  BUILTIN_TOOLS,
  SPAWNING_TOOLS,
  CONTROL_TOOLS,
} from "../../pi-extension/subagents/sandbox.ts";
import type { SubagentLoadout } from "../../pi-extension/subagents/session.ts";

describe("sandbox.ts", () => {
  it("buildToolAllowlist returns null with no restriction and no spawning grant", () => {
    assert.equal(buildToolAllowlist(undefined), null);
    assert.equal(buildToolAllowlist(""), null);
    assert.equal(buildToolAllowlist("   "), null);
    assert.equal(buildToolAllowlist("  ,  ,  "), null);
    assert.equal(buildToolAllowlist("   ", { grantSpawning: false }), null);
  });

  it("buildToolAllowlist handles whitespace-only tools with grantSpawning", () => {
    const allow = buildToolAllowlist("   ", { grantSpawning: true })!;
    const set = new Set(allow.split(","));
    for (const t of [...SPAWNING_TOOLS, ...CONTROL_TOOLS]) {
      assert.ok(set.has(t), `expected ${t} in allowlist`);
    }
  });

  it("buildToolAllowlist unions requested tools with spawning + control tools", () => {
    const allow = buildToolAllowlist("read,bash", { grantSpawning: true })!;
    const set = new Set(allow.split(","));
    for (const t of ["read", "bash", ...SPAWNING_TOOLS, ...CONTROL_TOOLS]) {
      assert.ok(set.has(t), `expected ${t} in allowlist`);
    }
    // Built-in tools not explicitly requested are excluded from the allowlist.
    assert.ok(!set.has("write"));
  });

  it("builtin tools are known (no extension backing)", () => {
    for (const t of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
      assert.ok(BUILTIN_TOOLS.has(t));
    }
  });

  it("applySandboxToParts replays model, identity, and tool allowlist", () => {
    const d = mkdtempSync(join(tmpdir(), "iss-sandbox-"));
    const parts: string[] = [];
    const loadout: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,web_search,ask_question",
      model: "m",
      thinking: "high",
      systemPromptMode: "append",
      identity: "You are a worker.",
      spawnable: null,
      autoExit: true,
      cwd: null,
      agentDir: null,
    };
    applySandboxToParts(parts, loadout, { artifactDir: d, name: "worker" });
    const joined = parts.join(" ");
    assert.ok(joined.includes("--model"), "expected --model");
    assert.ok(joined.includes("m:high"), "expected model:thinking");
    assert.ok(joined.includes("--append-system-prompt"), "expected identity flag");
    assert.ok(!parts.includes("--no-extensions"), "should not pass --no-extensions");
    const toolsIdx = parts.indexOf("--tools");
    assert.ok(toolsIdx >= 0);
    assert.ok(parts[toolsIdx + 1].includes("read,write,web_search,ask_question"));
    rmSync(d, { recursive: true, force: true });
  });

  it("applySandboxToParts omits restriction flags when unrestricted", () => {
    const d = mkdtempSync(join(tmpdir(), "iss-sandbox-2-"));
    const parts: string[] = [];
    applySandboxToParts(
      parts,
      {
        agent: null,
        toolAllowlist: null,
        model: null,
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: false,
        cwd: null,
        agentDir: null,
      },
      { artifactDir: d, name: "fork" },
    );
    assert.deepEqual(parts, []);
    assert.ok(existsSync(d));
    rmSync(d, { recursive: true, force: true });
  });
});
