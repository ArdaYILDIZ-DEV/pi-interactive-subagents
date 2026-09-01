import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../../pi-extension/subagents/activity.ts";

describe("activity.ts", () => {
  it("writes an immediate activity file and reads it back", () => {
    const d = mkdtempSync(join(tmpdir(), "iss-activity-"));
    const file = getSubagentActivityFile(d, "child-1");
    let now = 1000;
    const recorder = createSubagentActivityRecorder({
      runningChildId: "child-1",
      activityFile: file,
      now: () => now,
    });
    recorder.sessionStart();
    recorder.agentStart();
    // Advance clock to verify immediate write behavior on completion.
    now = 2000;
    recorder.agentEndDone();

    assert.ok(existsSync(file));
    const view = readSubagentActivityFile(file, "child-1");
    assert.ok(view.ok);
    if (view.ok) {
      assert.equal(view.activity.phase, "done");
      assert.equal(view.activity.runningChildId, "child-1");
    }
    rmSync(d, { recursive: true, force: true });
  });

  it("returns ok:false for a missing file", () => {
    const d = mkdtempSync(join(tmpdir(), "iss-activity-2-"));
    const view = readSubagentActivityFile(getSubagentActivityFile(d, "x"), "x");
    assert.equal(view.ok, false);
    rmSync(d, { recursive: true, force: true });
  });

  it("records throttled tool activity without throwing", () => {
    const d = mkdtempSync(join(tmpdir(), "iss-activity-3-"));
    const file = getSubagentActivityFile(d, "c2");
    const recorder = createSubagentActivityRecorder({ runningChildId: "c2", activityFile: file });
    recorder.sessionStart();
    for (let i = 0; i < 50; i++) {
      recorder.toolStart();
      recorder.toolEnd();
    }
    const raw = readFileSync(file, "utf8");
    assert.ok(raw.includes('"runningChildId":"c2"'));
    rmSync(d, { recursive: true, force: true });
  });
});
