/**
 * Sandbox builder for child subagent processes.
 *
 * All extensions are loaded naturally by pi (no --no-extensions).
 * Tool access is controlled via `--tools <allowlist>` when specified by the agent.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellEscape } from "./tmux.ts";
import type { SubagentLoadout } from "./session.ts";

/** Built-in core tools provided by the pi runtime. */
export const BUILTIN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);

/** Subagent orchestration tools granted when spawning privileges are enabled. */
export const SPAWNING_TOOLS = ["subagent", "subagent_message", "subagents_list"] as const;

/** Interactive control tools available in restricted subagent environments. */
export const CONTROL_TOOLS = ["ask_question"] as const;

/**
 * Normalizes a subagent display name into a filesystem-safe ASCII identifier.
 */
export function sanitizeSubagentName(name: string, fallback = "subagent"): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || fallback;
}

/**
 * Builds the `--tools` allowlist argument for a subagent.
 *
 * Returns null if no restrictions apply so the child retains default tools.
 * Otherwise combines requested tools with orchestration and control tools.
 */
export function buildToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean },
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const grantSpawning = opts?.grantSpawning ?? false;

  if (requested.length === 0 && !grantSpawning) return null;

  const allow = new Set(requested);
  if (grantSpawning) for (const tool of SPAWNING_TOOLS) allow.add(tool);
  for (const tool of CONTROL_TOOLS) allow.add(tool);

  return [...allow].join(",");
}

/**
 * Applies sandbox flags (model, identity, and tool allowlist) to child CLI arguments.
 * Shared between initial spawn and session resume to prevent configuration drift.
 */
export function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", shellEscape(model));
  }

  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = sanitizeSubagentName(opts.name, "subagent");
    const spPath = join(
      opts.artifactDir,
      `context/${spSafeName}-sysprompt-${spTimestamp}.md`,
    );
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, shellEscape(spPath));
  }

  if (loadout.toolAllowlist) {
    parts.push("--tools", shellEscape(loadout.toolAllowlist));
  }
}
