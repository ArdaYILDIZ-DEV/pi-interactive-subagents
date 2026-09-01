import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getFrontmatterValue,
  parseCommaList,
  parseOptionalBoolean,
  parseSystemPromptMode,
  parseAgentDefinition,
  resolveSubagentPaths,
  buildSubagentEnv,
  buildScriptPreamble,
  buildSubagentCliParts,
  buildSubagentCommand,
  composeSubagentTask,
  buildSkillPromptArgs,
  writeTaskArtifact,
  writeResumeMessageArtifact,
  computeUniqueName,
  findSubagentByName,
  formatElapsed,
  borderLine,
  borderTop,
  borderBottom,
  resolveResultPresentation,
  type SubagentResult,
} from "../../pi-extension/subagents/index.ts";
import { sanitizeSubagentName } from "../../pi-extension/subagents/sandbox.ts";
import type { SubagentLoadout } from "../../pi-extension/subagents/session.ts";

describe("index.ts - extracted helpers & decoupling", () => {
  describe("sanitizeSubagentName", () => {
    it("normalizes names to lowercase ASCII slugs", () => {
      assert.equal(sanitizeSubagentName("Worker"), "worker");
      assert.equal(sanitizeSubagentName("My Agent #1!"), "my-agent-1");
      assert.equal(sanitizeSubagentName("---foo---bar---"), "foo-bar");
      assert.equal(sanitizeSubagentName(""), "subagent");
      assert.equal(sanitizeSubagentName("   ", "fallback-name"), "fallback-name");
    });
  });

  describe("frontmatter parsers", () => {
    it("getFrontmatterValue extracts values by key", () => {
      const fm = "name: scout\nmodel: gpt-4o\ndescription: A scout agent";
      assert.equal(getFrontmatterValue(fm, "name"), "scout");
      assert.equal(getFrontmatterValue(fm, "model"), "gpt-4o");
      assert.equal(getFrontmatterValue(fm, "unknown"), undefined);
    });

    it("parseCommaList splits and trims lists", () => {
      assert.deepEqual(parseCommaList("a, b, c"), ["a", "b", "c"]);
      assert.deepEqual(parseCommaList("  foo ,  , bar  "), ["foo", "bar"]);
      assert.equal(parseCommaList(undefined), undefined);
      assert.equal(parseCommaList("  ,  "), undefined);
    });

    it("parseOptionalBoolean returns boolean or undefined", () => {
      assert.equal(parseOptionalBoolean("true"), true);
      assert.equal(parseOptionalBoolean("false"), false);
      assert.equal(parseOptionalBoolean(undefined), undefined);
    });

    it("parseSystemPromptMode validates mode", () => {
      assert.equal(parseSystemPromptMode("replace"), "replace");
      assert.equal(parseSystemPromptMode("append"), "append");
      assert.equal(parseSystemPromptMode("invalid"), undefined);
      assert.equal(parseSystemPromptMode(undefined), undefined);
    });

    it("parseAgentDefinition parses full agent markdown", () => {
      const content = `---
name: test-agent
description: Test description
model: anthropic/claude-3-5-sonnet
tools: read,write,safe_bash
skills: debug,refactor
thinking: high
subagent_agents: scout,worker
auto-exit: true
interactive: false
system-prompt: append
disable-model-invocation: true
---
You are a test agent. Always verify.`;

      const parsed = parseAgentDefinition(content, "fallback");
      assert.ok(parsed);
      assert.equal(parsed.name, "test-agent");
      assert.equal(parsed.description, "Test description");
      assert.equal(parsed.model, "anthropic/claude-3-5-sonnet");
      assert.equal(parsed.tools, "read,write,safe_bash");
      assert.equal(parsed.skills, "debug,refactor");
      assert.equal(parsed.thinking, "high");
      assert.deepEqual(parsed.subagentAgents, ["scout", "worker"]);
      assert.equal(parsed.autoExit, true);
      assert.equal(parsed.interactive, false);
      assert.equal(parsed.systemPromptMode, "append");
      assert.equal(parsed.disableModelInvocation, true);
      assert.equal(parsed.body, "You are a test agent. Always verify.");
    });

    it("parseAgentDefinition returns null if frontmatter is missing", () => {
      assert.equal(parseAgentDefinition("No frontmatter here", "fallback"), null);
    });
  });

  describe("resolveSubagentPaths", () => {
    it("handles explicit absolute and relative cwds", () => {
      const res1 = resolveSubagentPaths({ cwd: "/custom/path" }, null);
      assert.equal(res1.effectiveCwd, "/custom/path");

      const res2 = resolveSubagentPaths({}, { name: "test", disableModelInvocation: false, cwd: "relative/dir" });
      assert.ok(res2.effectiveCwd?.endsWith("relative/dir"));
    });
  });

  describe("computeUniqueName", () => {
    it("returns base name when not taken", () => {
      const taken = new Set(["other-1", "other-2"]);
      assert.equal(computeUniqueName("worker", taken), "worker");
    });

    it("increments suffix when base name is taken", () => {
      const taken = new Set(["worker", "worker-2"]);
      assert.equal(computeUniqueName("worker", taken), "worker-3");
    });
  });

  describe("findSubagentByName", () => {
    const list = [
      { id: "1", name: "scout" },
      { id: "2", name: "Worker" },
      { id: "3", name: "worker" },
    ];

    it("returns error for empty name", () => {
      const res = findSubagentByName(list, "   ");
      assert.ok("error" in res);
    });

    it("finds exact matches", () => {
      const res = findSubagentByName(list, "scout");
      assert.ok("found" in res && res.found.id === "1");
    });

    it("detects ambiguous matches when multiple match case-insensitively", () => {
      const res = findSubagentByName(list, "WORKER");
      assert.ok("error" in res && res.error.includes("Ambiguous"));
    });

    it("provides running list when name is not found", () => {
      const res = findSubagentByName(list, "nonexistent");
      assert.ok("error" in res && res.error.includes("Currently running: scout, Worker, worker"));
    });
  });

  describe("buildSubagentEnv", () => {
    it("assembles environment variables correctly", () => {
      const env = buildSubagentEnv({
        surface: "%1",
        sessionFile: "/path/to/session.jsonl",
        id: "abc12345",
        name: "test-subagent",
        activityFile: "/path/to/act.json",
        agent: "scout",
        agentDir: "/custom/agent/dir",
        allowedAgents: ["worker", "researcher"],
        autoExit: true,
      });

      assert.ok(env.some((e) => e.startsWith("TMUX_PANE=")));
      assert.ok(env.includes("PI_CODING_AGENT_DIR='/custom/agent/dir'"));
      assert.ok(env.includes("PI_SUBAGENT_ALLOWED='worker,researcher'"));
      assert.ok(env.includes("PI_SUBAGENT_NAME='test-subagent'"));
      assert.ok(env.includes("PI_SUBAGENT_SESSION='/path/to/session.jsonl'"));
      assert.ok(env.includes("PI_SUBAGENT_ID='abc12345'"));
      assert.ok(env.includes("PI_SUBAGENT_ACTIVITY_FILE='/path/to/act.json'"));
      assert.ok(env.includes("PI_SUBAGENT_SURFACE='%1'"));
      assert.ok(env.includes("PI_SUBAGENT_AGENT='scout'"));
      assert.ok(env.includes("PI_SUBAGENT_AUTO_EXIT=1"));
    });

    it("omits PI_SUBAGENT_AUTO_EXIT when autoExit is false", () => {
      const env = buildSubagentEnv({
        surface: "%1",
        sessionFile: "/s.jsonl",
        id: "1",
        name: "agent",
        autoExit: false,
      });
      assert.ok(!env.some((e) => e.includes("PI_SUBAGENT_AUTO_EXIT")));
    });
  });

  describe("buildScriptPreamble", () => {
    it("formats launch and resume preambles", () => {
      const p1 = buildScriptPreamble("launch", "worker", "/s.jsonl", "%2", "2026-08-30T00:00:00.000Z");
      assert.equal(
        p1,
        "# Subagent launch script for worker\n# Generated: 2026-08-30T00:00:00.000Z\n# Session: /s.jsonl\n# Surface: %2",
      );

      const p2 = buildScriptPreamble("resume", "scout", "/s.jsonl", "%3", "2026-08-30T00:00:00.000Z");
      assert.equal(
        p2,
        "# Subagent resume script for scout\n# Generated: 2026-08-30T00:00:00.000Z\n# Session: /s.jsonl\n# Surface: %3",
      );
    });
  });

  describe("buildSubagentCliParts & buildSubagentCommand", () => {
    it("assembles CLI parts and full command string", () => {
      const d = mkdtempSync(join(tmpdir(), "iss-cmd-test-"));
      const loadout: SubagentLoadout = {
        agent: "worker",
        toolAllowlist: "read,safe_bash,ask_question",
        model: "m",
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: ["scout"],
        autoExit: true,
        cwd: "/custom/cwd",
        agentDir: null,
      };

      const parts = buildSubagentCliParts("/session.jsonl", loadout, {
        artifactDir: d,
        name: "worker",
      });

      assert.ok(parts[0] === "pi");
      assert.ok(parts.includes("--session"));
      // Includes subagents index because spawnable is non-empty
      assert.ok(parts.some((p) => p.includes("index.ts")));
      // Includes safe-bash because safe_bash is in toolAllowlist
      assert.ok(parts.some((p) => p.includes("safe-bash.ts")));

      const envParts = ["FOO='bar'"];
      const cmd = buildSubagentCommand({
        cwd: "/custom/cwd",
        envParts,
        parts,
      });

      assert.ok(cmd.startsWith("cd '/custom/cwd' && FOO='bar' pi "));
      assert.ok(cmd.endsWith("; echo '__SUBAGENT_DONE_'$?'__'"));

      rmSync(d, { recursive: true, force: true });
    });
  });

  describe("task composition & artifact writers", () => {
    it("composeSubagentTask adds autonomous mode hints and final summary instructions", () => {
      const task = composeSubagentTask({
        task: "Fix the bug",
        autoExit: true,
        identity: "You are a specialist.",
        systemPromptMode: undefined,
      });
      assert.ok(task.includes("You are a specialist."));
      assert.ok(task.includes("Complete your task autonomously."));
      assert.ok(task.includes("Fix the bug"));
      assert.ok(task.includes("Your FINAL assistant message should summarize what you accomplished."));
    });

    it("buildSkillPromptArgs formats skill arguments", () => {
      assert.deepEqual(buildSkillPromptArgs("refactor, test"), ["", "/skill:refactor", "/skill:test"]);
      assert.deepEqual(buildSkillPromptArgs(""), []);
      assert.deepEqual(buildSkillPromptArgs(undefined), []);
    });

    it("writeTaskArtifact and writeResumeMessageArtifact write files to artifact directories", () => {
      const d = mkdtempSync(join(tmpdir(), "iss-art-test-"));
      const taskPath = writeTaskArtifact(d, "worker", "Task instructions", "2026-08-30T12-00-00");
      assert.ok(existsSync(taskPath));
      assert.equal(readFileSync(taskPath, "utf8"), "Task instructions");

      const resumePath = writeResumeMessageArtifact(d, "worker", "Follow-up message", "2026-08-30T12-00-00");
      assert.ok(existsSync(resumePath));
      assert.equal(readFileSync(resumePath, "utf8"), "Follow-up message");

      rmSync(d, { recursive: true, force: true });
    });
  });

  describe("formatElapsed & result presentation", () => {
    it("formatElapsed formats seconds and minutes", () => {
      assert.equal(formatElapsed(15), "15s");
      assert.equal(formatElapsed(60), "1m 0s");
      assert.equal(formatElapsed(125), "2m 5s");
    });

    it("resolveResultPresentation formats success, failure, and error results", () => {
      const successRes: SubagentResult = {
        name: "worker",
        task: "do work",
        summary: "Task finished successfully.",
        exitCode: 0,
        elapsed: 10,
      };
      const formattedSuccess = resolveResultPresentation(successRes);
      assert.ok(formattedSuccess.includes('Sub-agent "worker" completed (10s).'));
      assert.ok(formattedSuccess.includes("Task finished successfully."));
      assert.ok(formattedSuccess.includes('subagent_message({ name: "worker", message: "…" })'));

      const failRes: SubagentResult = {
        name: "worker",
        task: "do work",
        summary: "Exited with error",
        exitCode: 2,
        elapsed: 5,
      };
      const formattedFail = resolveResultPresentation(failRes);
      assert.ok(formattedFail.includes('Sub-agent "worker" failed (exit code 2).'));

      const errorRes: SubagentResult = {
        name: "worker",
        task: "do work",
        summary: "",
        exitCode: 1,
        elapsed: 3,
        errorMessage: "Rate limit exceeded",
      };
      const formattedError = resolveResultPresentation(errorRes);
      assert.ok(formattedError.includes("provider/agent error — auto-retry exhausted"));
      assert.ok(formattedError.includes("Rate limit exceeded"));
    });
  });

  describe("widget borders", () => {
    it("renders top, bottom, and content borders safely", () => {
      const top = borderTop("Subagents", "1 running", 40);
      assert.ok(top.includes("Subagents"));
      assert.ok(top.includes("1 running"));

      const line = borderLine("left text", "right text", 40);
      assert.ok(line.includes("left text"));
      assert.ok(line.includes("right text"));

      const bottom = borderBottom(40);
      assert.ok(bottom.includes("╰"));

      // Width <= 0 edge cases
      assert.equal(borderTop("T", "I", 0), "");
      assert.equal(borderLine("L", "R", 0), "");
      assert.equal(borderBottom(0), "");
    });
  });
});
