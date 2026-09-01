import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForFile,
  waitForPiExit,
  waitForScreen,
  isMuxAvailable,
  TEST_MODEL,
} from "./harness.ts";

describe("Subagent Integration Tests", { skip: !isMuxAvailable() }, () => {
  let env: ReturnType<typeof createTestEnv>;

  afterEach(() => {
    if (env) cleanupTestEnv(env);
  });

  it("spawns a subagent that executes bash tool and returns results", async () => {
    env = createTestEnv();
    const surface = createTrackedSurface(env, "orchestrator");
    const outputFile = join(env.dir, "subagent_output.txt");

    const task = `Use the subagent tool to spawn the "test-echo" agent with the task: "Run the command echo 'SUBAGENT_TOOL_OK' > ${outputFile} and then finish." Do not run the command yourself, use subagent.`;

    startPi(surface, env.dir, task, {
      model: TEST_MODEL,
    });

    // Await tool execution and file output from the subagent.
    const content = await waitForFile(outputFile, 120_000, /SUBAGENT_TOOL_OK/);
    assert.ok(content.includes("SUBAGENT_TOOL_OK"), "Subagent executed bash tool and created file");
  });

  it("resumes a finished subagent with subagent_message and verifies memory retention", async () => {
    env = createTestEnv();
    const surface = createTrackedSurface(env, "orchestrator");
    const step1File = join(env.dir, "step1.txt");
    const step2File = join(env.dir, "step2.txt");

    const task = `1. Use subagent to spawn "test-echo" named "memory-agent" with task "Run echo 'SECRET_TOKEN_42' > ${step1File}".
2. After memory-agent finishes, use subagent_message on "memory-agent" with message "Run echo 'RECEIVED_'$(cat ${step1File}) > ${step2File}".`;

    startPi(surface, env.dir, task, {
      model: TEST_MODEL,
    });

    const content1 = await waitForFile(step1File, 120_000, /SECRET_TOKEN_42/);
    assert.ok(content1.includes("SECRET_TOKEN_42"), "Step 1 executed");

    const content2 = await waitForFile(step2File, 120_000, /RECEIVED_SECRET_TOKEN_42/);
    assert.ok(content2.includes("RECEIVED_SECRET_TOKEN_42"), "Step 2 resumed with memory");
  });

  it("handles subagent ask_question and steers reply back to subagent", async () => {
    env = createTestEnv();
    const surface = createTrackedSurface(env, "orchestrator");
    const pingOutputFile = join(env.dir, "ping_done.txt");

    const task = `1. Use subagent to spawn "test-ping" named "pinger" with task "Need instructions".
2. When pinger asks its question, use subagent_message to reply with: "Execute bash command echo 'PING_REPLY_OK' > ${pingOutputFile}".`;

    startPi(surface, env.dir, task, {
      model: TEST_MODEL,
    });

    const content = await waitForFile(pingOutputFile, 120_000, /PING_REPLY_OK/);
    assert.ok(content.includes("PING_REPLY_OK"), "Ping reply was received and executed by subagent");
  });
});
