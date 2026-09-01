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
  isMuxAvailable,
  TEST_MODEL,
} from "./harness.ts";

describe("Nested Subagent Integration Tests", { skip: !isMuxAvailable() }, () => {
  let env: ReturnType<typeof createTestEnv>;

  afterEach(() => {
    if (env) cleanupTestEnv(env);
  });

  it("nested subagent: parent spawns worker which spawns test-echo, and both auto-exit cleanly", async () => {
    env = createTestEnv();
    const surface = createTrackedSurface(env, "orchestrator");
    const childOutputFile = join(env.dir, "nested_child_done.txt");
    const finalOutputFile = join(env.dir, "nested_final_done.txt");

    const task = `Use subagent to spawn "test-boss" named "boss-1" with task: "Use your subagent tool to spawn the 'test-echo' agent with task: 'echo NESTED_CHILD_OK > ${childOutputFile}'. When test-echo finishes, run the command echo 'NESTED_BOSS_OK' > ${finalOutputFile} and then finish." Do not do it yourself, use subagent.`;

    startPi(surface, env.dir, task, {
      model: TEST_MODEL,
    });

    // 1. Await file generation from the spawned child subagent.
    const childContent = await waitForFile(childOutputFile, 120_000, /NESTED_CHILD_OK/);
    assert.ok(childContent.includes("NESTED_CHILD_OK"), "Nested child executed");

    // 2. Await orchestrator processing of child output and final file generation.
    const finalContent = await waitForFile(finalOutputFile, 120_000, /NESTED_BOSS_OK/);
    assert.ok(finalContent.includes("NESTED_BOSS_OK"), "Boss received child result and finished");
  });
});
