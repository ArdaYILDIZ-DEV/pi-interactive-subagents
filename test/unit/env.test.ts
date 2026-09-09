import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEnvInt } from "../../pi-extension/subagents/env.ts";

describe("env.ts - parseEnvInt", () => {
  it("falls back on undefined, empty string, and whitespace", () => {
    assert.equal(parseEnvInt(undefined, 42, 0), 42);
    assert.equal(parseEnvInt("", 42, 0), 42);
    assert.equal(parseEnvInt(" ", 42, 0), 42);
    assert.equal(parseEnvInt("   \t\n  ", 42, 0), 42);
  });

  it("falls back on non-numeric input", () => {
    assert.equal(parseEnvInt("abc", 42, 0), 42);
    assert.equal(parseEnvInt("hello world", 42, 0), 42);
    assert.equal(parseEnvInt("---", 42, 0), 42);
    assert.equal(parseEnvInt("foo123", 42, 0), 42);
  });

  it("falls back on NaN-producing strings", () => {
    assert.equal(parseEnvInt("NaN", 42, 0), 42);
    assert.equal(parseEnvInt("+", 42, 0), 42);
    assert.equal(parseEnvInt("-", 42, 0), 42);
    assert.equal(parseEnvInt("Infinity", 42, 0), 42);
    assert.equal(parseEnvInt("-Infinity", 42, 0), 42);
  });

  it("handles negative numbers against min threshold", () => {
    assert.equal(parseEnvInt("-1", 500, 0), 500);
    assert.equal(parseEnvInt("-100", 15_000, 1), 15_000);
    assert.equal(parseEnvInt("-5", 100, -10), -5);
    assert.equal(parseEnvInt("-15", 100, -10), 100);
  });

  it("distinguishes zero with min 0 vs min 1", () => {
    assert.equal(parseEnvInt("0", 500, 0), 0);
    assert.equal(parseEnvInt("  0  ", 500, 0), 0);
    assert.equal(parseEnvInt("0", 15_000, 1), 15_000);
    assert.equal(parseEnvInt("  0  ", 15_000, 1), 15_000);
    assert.equal(parseEnvInt("1", 15_000, 1), 1);
  });

  it("truncates fractional values according to parseInt semantics", () => {
    assert.equal(parseEnvInt("42.9", 0, 0), 42);
    assert.equal(parseEnvInt("123.456", 0, 0), 123);
    assert.equal(parseEnvInt("0.99", 500, 1), 500);
    assert.equal(parseEnvInt("0.99", 500, 0), 0);
    assert.equal(parseEnvInt("1.5", 500, 1), 1);
  });

  it("parses huge finite integers", () => {
    const maxSafe = Number.MAX_SAFE_INTEGER;
    assert.equal(parseEnvInt(String(maxSafe), 0, 0), maxSafe);
    assert.equal(parseEnvInt("1000000000", 0, 1), 1000000000);
    assert.equal(parseEnvInt("999999999", 0, 0), 999999999);
  });

  it("returns the original fallback untouched on parse failure", () => {
    const fallbacks = [0, 500, 15_000, -1, 42, 999_999];
    for (const fb of fallbacks) {
      assert.equal(parseEnvInt(undefined, fb, 0), fb);
      assert.equal(parseEnvInt("invalid", fb, 0), fb);
      assert.equal(parseEnvInt("-5", fb, 0), fb);
      assert.equal(parseEnvInt("0", fb, 1), fb);
    }
  });

  it("parses valid positive values with optional surrounding whitespace", () => {
    assert.equal(parseEnvInt("  15000  ", 500, 1), 15000);
    assert.equal(parseEnvInt("500", 0, 0), 500);
  });
});
