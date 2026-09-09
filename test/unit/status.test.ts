import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadStatusConfig,
  classifyActivity,
  DEFAULT_STATUS_CONFIG,
  DEFAULT_STALL_AFTER_MS,
  sanitizeStallThreshold,
} from "../../pi-extension/subagents/status.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "iss-status-"));
}

describe("status.ts", () => {
  it("returns a safe default when no config file exists (does not throw)", () => {
    const d = tmp();
    const cfg = loadStatusConfig(
      join(d, "config.json"),
      join(d, "config.json.example"),
    );
    assert.deepEqual(cfg, { ...DEFAULT_STATUS_CONFIG });
    rmSync(d, { recursive: true, force: true });
  });

  it("prefers a local config.json over the example", () => {
    const d = tmp();
    writeFileSync(
      join(d, "config.json"),
      JSON.stringify({ status: { enabled: false } }),
    );
    writeFileSync(
      join(d, "config.json.example"),
      JSON.stringify({ status: { enabled: true } }),
    );
    const cfg = loadStatusConfig(
      join(d, "config.json"),
      join(d, "config.json.example"),
    );
    assert.deepEqual(cfg, {
      enabled: false,
      lineLimit: 4,
      stallAfterMs: DEFAULT_STALL_AFTER_MS,
    });
    rmSync(d, { recursive: true, force: true });
  });

  it("falls back to the example when local config is absent", () => {
    const d = tmp();
    writeFileSync(
      join(d, "config.json.example"),
      JSON.stringify({ status: { enabled: false } }),
    );
    const cfg = loadStatusConfig(
      join(d, "nope.json"),
      join(d, "config.json.example"),
    );
    assert.equal(cfg.enabled, false);
    rmSync(d, { recursive: true, force: true });
  });

  it("reads a custom stallAfterMs value and falls back for invalid values", () => {
    const d = tmp();
    writeFileSync(
      join(d, "config.json"),
      JSON.stringify({ status: { enabled: true, stallAfterMs: 30000 } }),
    );
    assert.equal(
      loadStatusConfig(join(d, "config.json"), join(d, "missing.json"))
        .stallAfterMs,
      30000,
    );
    writeFileSync(
      join(d, "config.json"),
      JSON.stringify({ status: { enabled: true, stallAfterMs: -5 } }),
    );
    assert.equal(
      loadStatusConfig(join(d, "config.json"), join(d, "missing.json"))
        .stallAfterMs,
      DEFAULT_STALL_AFTER_MS,
    );
    rmSync(d, { recursive: true, force: true });
  });

  it("throws on a structurally invalid config (so mistakes surface early)", () => {
    const d = tmp();
    writeFileSync(
      join(d, "config.json"),
      JSON.stringify({ status: { enabled: "yes" } }),
    );
    assert.throws(
      () =>
        loadStatusConfig(
          join(d, "config.json"),
          join(d, "config.json.example"),
        ),
      /status\.enabled must be a boolean/,
    );
    rmSync(d, { recursive: true, force: true });
  });

  it("classifies starting/active/waiting/stalled from activity recency", () => {
    const now = 1_000_000;
    assert.equal(
      classifyActivity({ ok: true, phase: "missing", updatedAt: now - 10 }, now)
        .kind,
      "starting",
    );
    assert.equal(
      classifyActivity(
        { ok: true, phase: "active", updatedAt: now - 1000 },
        now,
      ).kind,
      "active",
    );
    assert.equal(
      classifyActivity(
        { ok: true, phase: "waiting", updatedAt: now - 1000 },
        now,
      ).kind,
      "waiting",
    );
    // With the default 180s threshold, 120s of silence is still active, not stalled.
    assert.equal(
      classifyActivity(
        { ok: true, phase: "active", updatedAt: now - 120_000 },
        now,
      ).kind,
      "active",
    );
    // Activity exceeding the inactivity threshold transitions to stalled.
    assert.equal(
      classifyActivity(
        { ok: true, phase: "active", updatedAt: now - 200_000 },
        now,
      ).kind,
      "stalled",
    );
    assert.equal(
      classifyActivity(
        { ok: false, phase: "missing", updatedAt: now - 200_000 },
        now,
      ).kind,
      "stalled",
    );
    // A custom threshold overrides the default.
    assert.equal(
      classifyActivity(
        { ok: true, phase: "active", updatedAt: now - 120_000 },
        now,
        60_000,
      ).kind,
      "stalled",
    );
  });

  describe("sanitizeStallThreshold", () => {
    it("returns floored positive finite numbers", () => {
      assert.equal(sanitizeStallThreshold(60_000), 60_000);
      assert.equal(sanitizeStallThreshold(30_000.9), 30_000);
      assert.equal(sanitizeStallThreshold(1e12), 1e12);
      assert.equal(sanitizeStallThreshold(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    });

    it("falls back to DEFAULT_STALL_AFTER_MS for non-positive or non-finite numbers", () => {
      assert.equal(sanitizeStallThreshold(0), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold(-1), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold(-5000), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold(NaN), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold(Infinity), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold(-Infinity), DEFAULT_STALL_AFTER_MS);
    });

    it("falls back to DEFAULT_STALL_AFTER_MS for non-number inputs", () => {
      assert.equal(sanitizeStallThreshold("not-a-number"), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold("180000"), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold(null), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold(undefined), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold({}), DEFAULT_STALL_AFTER_MS);
      assert.equal(sanitizeStallThreshold(true), DEFAULT_STALL_AFTER_MS);
    });
  });

  describe("parseConfig stallAfterMs edge cases", () => {
    it("handles valid and invalid stallAfterMs in config", () => {
      const d = tmp();
      const testCases: Array<{ input: unknown; expected: number }> = [
        { input: 30000.9, expected: 30000 },
        { input: 1e12, expected: 1e12 },
        { input: 0, expected: DEFAULT_STALL_AFTER_MS },
        { input: -10, expected: DEFAULT_STALL_AFTER_MS },
        { input: "invalid", expected: DEFAULT_STALL_AFTER_MS },
        { input: null, expected: DEFAULT_STALL_AFTER_MS },
      ];

      for (const tc of testCases) {
        writeFileSync(
          join(d, "config.json"),
          JSON.stringify({ status: { enabled: true, stallAfterMs: tc.input } }),
        );
        const cfg = loadStatusConfig(
          join(d, "config.json"),
          join(d, "config.json.example"),
        );
        assert.equal(cfg.stallAfterMs, tc.expected);
      }
      rmSync(d, { recursive: true, force: true });
    });
  });

  describe("classifyActivity invalid threshold fallback", () => {
    it("falls back to default threshold when stallAfterMs is invalid", () => {
      const now = 1_000_000;
      // 120s of silence is within DEFAULT_STALL_AFTER_MS (180s)
      const invalidThresholds = [NaN, 0, -1, -50_000, "invalid" as unknown as number];

      for (const invalid of invalidThresholds) {
        assert.equal(
          classifyActivity(
            { ok: true, phase: "active", updatedAt: now - 120_000 },
            now,
            invalid,
          ).kind,
          "active",
        );
        assert.equal(
          classifyActivity(
            { ok: true, phase: "active", updatedAt: now - 200_000 },
            now,
            invalid,
          ).kind,
          "stalled",
        );
        assert.equal(
          classifyActivity(
            { ok: false, phase: "missing", updatedAt: now - 120_000 },
            now,
            invalid,
          ).kind,
          "starting",
        );
      }
    });
  });

  it("existsSync import works (sanity for dependency-free module)", () => {
    assert.equal(existsSync("/this/path/does/not/exist"), false);
  });
});
