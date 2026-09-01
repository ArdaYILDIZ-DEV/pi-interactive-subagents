import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStatusConfig, classifyActivity, DEFAULT_STATUS_CONFIG } from "../../pi-extension/subagents/status.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "iss-status-"));
}

describe("status.ts", () => {
  it("returns a safe default when no config file exists (does not throw)", () => {
    const d = tmp();
    const cfg = loadStatusConfig(join(d, "config.json"), join(d, "config.json.example"));
    assert.deepEqual(cfg, { ...DEFAULT_STATUS_CONFIG });
    rmSync(d, { recursive: true, force: true });
  });

  it("prefers a local config.json over the example", () => {
    const d = tmp();
    writeFileSync(join(d, "config.json"), JSON.stringify({ status: { enabled: false } }));
    writeFileSync(join(d, "config.json.example"), JSON.stringify({ status: { enabled: true } }));
    const cfg = loadStatusConfig(join(d, "config.json"), join(d, "config.json.example"));
    assert.deepEqual(cfg, { enabled: false, lineLimit: 4 });
    rmSync(d, { recursive: true, force: true });
  });

  it("falls back to the example when local config is absent", () => {
    const d = tmp();
    writeFileSync(join(d, "config.json.example"), JSON.stringify({ status: { enabled: false } }));
    const cfg = loadStatusConfig(join(d, "nope.json"), join(d, "config.json.example"));
    assert.equal(cfg.enabled, false);
    rmSync(d, { recursive: true, force: true });
  });

  it("throws on a structurally invalid config (so mistakes surface early)", () => {
    const d = tmp();
    writeFileSync(join(d, "config.json"), JSON.stringify({ status: { enabled: "yes" } }));
    assert.throws(
      () => loadStatusConfig(join(d, "config.json"), join(d, "config.json.example")),
      /status\.enabled must be a boolean/,
    );
    rmSync(d, { recursive: true, force: true });
  });

  it("classifies starting/active/waiting/stalled from activity recency", () => {
    const now = 1_000_000;
    assert.equal(classifyActivity({ ok: true, phase: "missing", updatedAt: now - 10 }, now).kind, "starting");
    assert.equal(classifyActivity({ ok: true, phase: "active", updatedAt: now - 1000 }, now).kind, "active");
    assert.equal(classifyActivity({ ok: true, phase: "waiting", updatedAt: now - 1000 }, now).kind, "waiting");
    // Activity exceeding the inactivity threshold transitions to stalled.
    assert.equal(
      classifyActivity({ ok: true, phase: "active", updatedAt: now - 120_000 }, now).kind,
      "stalled",
    );
    assert.equal(
      classifyActivity({ ok: false, phase: "missing", updatedAt: now - 120_000 }, now).kind,
      "stalled",
    );
  });

  it("existsSync import works (sanity for dependency-free module)", () => {
    assert.equal(existsSync("/this/path/does/not/exist"), false);
  });
});
