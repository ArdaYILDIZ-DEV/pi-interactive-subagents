import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellEscape, __test__ } from "../../pi-extension/subagents/tmux.ts";

describe("tmux.ts", () => {
  it("shellEscape quotes single quotes safely and strips null bytes", () => {
    assert.equal(shellEscape("hello"), "'hello'");
    assert.equal(shellEscape("it's"), "'it'\\''s'");
    assert.equal(shellEscape("a'b'c"), "'a'\\''b'\\''c'");
    assert.equal(shellEscape(""), "''");
    assert.equal(shellEscape("hello\0world"), "'helloworld'");
  });

  it("hasCommand securely checks command availability without injection vulnerability", () => {
    __test__.clearCache();
    try {
      // Standard system commands
      assert.equal(__test__.hasCommand("sh"), true);
      assert.equal(__test__.hasCommand("nonexistent_command_12345"), false);
      // Metacharacter injection attempt should return false, not execute
      assert.equal(__test__.hasCommand("sh; echo injected"), false);
    } finally {
      __test__.clearCache();
    }
  });

  it("interpretExitSidecar maps error sidecars", () => {
    assert.deepEqual(
      __test__.interpretExitSidecar({ type: "error", errorMessage: "boom" }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "boom",
      },
    );
    assert.deepEqual(__test__.interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
    assert.deepEqual(__test__.interpretExitSidecar({ type: "error" }), {
      reason: "error",
      exitCode: 1,
      errorMessage:
        "Subagent exited with stopReason=error (no errorMessage in sidecar).",
    });
  });

  it("interpretExitSidecar rejects unknown payloads and preserves error fallbacks", () => {
    for (const data of [{}, null, [], true, { type: "future-value" }]) {
      assert.deepEqual(__test__.interpretExitSidecar(data), {
        reason: "error",
        exitCode: 1,
        errorMessage: "Invalid subagent completion sidecar: expected type 'done' or 'error'.",
      });
    }
    // Blank or non-string errorMessage falls back to the default message.
    assert.deepEqual(
      __test__.interpretExitSidecar({ type: "error", errorMessage: "   " }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage:
          "Subagent exited with stopReason=error (no errorMessage in sidecar).",
      },
    );
    assert.deepEqual(
      __test__.interpretExitSidecar({ type: "error", errorMessage: 42 }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage:
          "Subagent exited with stopReason=error (no errorMessage in sidecar).",
      },
    );
  });
});
