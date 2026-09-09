/**
 * Status widget configuration loader and activity state classification.
 *
 * Reads status display preferences with fallback to safe defaults
 * to prevent configuration errors from blocking extension initialization.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface StatusConfig {
  /** Whether the live status widget is shown above the editor. */
  enabled: boolean;
  /** Maximum number of widget rows rendered per status refresh. */
  lineLimit: number;
  /** Milliseconds without activity updates before a subagent is shown as stalled. */
  stallAfterMs: number;
}

/** Root directory of the package, used to locate configuration files. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

export const DEFAULT_STATUS_CONFIG: StatusConfig = {
  enabled: true,
  lineLimit: 4,
  stallAfterMs: 180_000,
};

export const DEFAULT_STALL_AFTER_MS = 180_000;

function readJson(path: string): unknown | null {
  if (typeof path !== "string" || path.includes("\0")) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseConfig(raw: unknown): StatusConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("status config must be an object");
  }
  const root = raw as Record<string, unknown>;
  const status = root.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("status config missing a 'status' object");
  }
  const s = status as Record<string, unknown>;
  if (typeof s.enabled !== "boolean") {
    throw new Error("status.enabled must be a boolean");
  }
  const lineLimit =
    typeof s.lineLimit === "number" &&
    Number.isFinite(s.lineLimit) &&
    s.lineLimit > 0
      ? Math.floor(s.lineLimit)
      : DEFAULT_STATUS_CONFIG.lineLimit;
  const stallAfterMs =
    typeof s.stallAfterMs === "number" &&
    Number.isFinite(s.stallAfterMs) &&
    s.stallAfterMs > 0
      ? Math.floor(s.stallAfterMs)
      : DEFAULT_STATUS_CONFIG.stallAfterMs;
  return { enabled: s.enabled, lineLimit, stallAfterMs };
}

export function loadStatusConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
  examplePath: string = EXAMPLE_CONFIG_PATH,
): StatusConfig {
  const local = readJson(configPath);
  if (local != null) return parseConfig(local);
  const example = readJson(examplePath);
  if (example != null) return parseConfig(example);
  // Fallback ensures the extension loads even when no configuration file is present.
  return { ...DEFAULT_STATUS_CONFIG };
}

// ── Status classification (used by the parent widget) ──

export type SubagentKind =
  | "starting"
  | "active"
  | "waiting"
  | "done"
  | "stalled";

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s}s`;
}

export interface ActivityView {
  ok: boolean;
  phase: "starting" | "active" | "waiting" | "done" | "missing";
  /** Unix timestamp (ms) of the child's last recorded activity. */
  updatedAt: number;
}

/**
 * Classifies a subagent's runtime state based on its last activity update.
 */
export function classifyActivity(
  view: ActivityView,
  now: number,
  stallAfterMs: number = DEFAULT_STALL_AFTER_MS,
): {
  kind: SubagentKind;
  elapsedText: string;
} {
  const elapsedMs = now - view.updatedAt;
  const elapsedText = formatDuration(elapsedMs);
  const threshold =
    Number.isFinite(stallAfterMs) && stallAfterMs > 0
      ? stallAfterMs
      : DEFAULT_STALL_AFTER_MS;

  // Unreported activity is classified as starting if recent, or stalled if overdue.
  if (!view.ok) {
    const kind: SubagentKind = elapsedMs >= threshold ? "stalled" : "starting";
    return { kind, elapsedText };
  }

  // Activity exceeding the stall threshold indicates a hung or crashed process.
  if (elapsedMs >= threshold) {
    return { kind: "stalled", elapsedText };
  }

  if (
    view.phase === "active" ||
    view.phase === "waiting" ||
    view.phase === "done"
  ) {
    return { kind: view.phase, elapsedText };
  }

  return { kind: "starting", elapsedText };
}
