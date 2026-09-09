/**
 * CLI / environment builders (extracted from `index.ts` — pure move, no behavior change).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellEscape } from "../tmux.ts";
import { applySandboxToParts } from "../sandbox.ts";
import type { SubagentLoadout } from "../session.ts";

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const SUBAGENTS_DIR = join(CLI_DIR, "..");
const SUBAGENT_DONE_PATH = join(SUBAGENTS_DIR, "subagent-done.ts");
const SUBAGENTS_INDEX_PATH = join(SUBAGENTS_DIR, "index.ts");
const SAFE_BASH_PATH = join(SUBAGENTS_DIR, "tools", "safe-bash.ts");

// ── Environment and Command Builders ──

export interface SubagentEnvOptions {
  surface: string;
  sessionFile: string;
  id: string;
  name: string;
  activityFile?: string;
  agent?: string | null;
  agentDir?: string | null;
  allowedAgents?: string[] | null;
  autoExit?: boolean;
}

export function buildSubagentEnv(opts: SubagentEnvOptions): string[] {
  const envParts: string[] = [];
  if (process.env.TMUX) envParts.push(`TMUX=${shellEscape(process.env.TMUX)}`);
  envParts.push(`TMUX_PANE=${shellEscape(opts.surface)}`);
  if (process.env.PATH) envParts.push(`PATH=${shellEscape(process.env.PATH)}`);
  const agentDir = opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null;
  if (agentDir) envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(agentDir)}`);
  if (opts.allowedAgents && opts.allowedAgents.length > 0) {
    envParts.push(
      `PI_SUBAGENT_ALLOWED=${shellEscape(opts.allowedAgents.join(","))}`,
    );
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(opts.name)}`);
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(opts.sessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(opts.id)}`);
  if (opts.activityFile)
    envParts.push(
      `PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(opts.activityFile)}`,
    );
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(opts.surface)}`);
  if (opts.agent) envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(opts.agent)}`);
  if (opts.autoExit) envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  return envParts;
}

export function buildScriptPreamble(
  action: "launch" | "resume",
  name: string,
  sessionFile: string,
  surface: string,
  timestamp?: string,
): string {
  const ts = timestamp ?? new Date().toISOString();
  return [
    `# Subagent ${action} script for ${name}`,
    `# Generated: ${ts}`,
    `# Session: ${sessionFile}`,
    `# Surface: ${surface}`,
  ].join("\n");
}

export interface SubagentCliOptions {
  artifactDir: string;
  name: string;
  paths?: {
    subagentDone?: string;
    subagentsIndex?: string;
    safeBash?: string;
  };
}

export function buildSubagentCliParts(
  sessionFile: string,
  loadout: SubagentLoadout,
  opts: SubagentCliOptions,
): string[] {
  const parts: string[] = ["pi", "--session", shellEscape(sessionFile)];
  const donePath = opts.paths?.subagentDone ?? SUBAGENT_DONE_PATH;
  const indexPath = opts.paths?.subagentsIndex ?? SUBAGENTS_INDEX_PATH;
  const safeBashPath = opts.paths?.safeBash ?? SAFE_BASH_PATH;

  parts.push("-e", shellEscape(donePath));
  if (loadout.spawnable && loadout.spawnable.length > 0) {
    parts.push("-e", shellEscape(indexPath));
  }
  if (loadout.toolAllowlist?.includes("safe_bash")) {
    parts.push("-e", shellEscape(safeBashPath));
  }
  applySandboxToParts(parts, loadout, {
    artifactDir: opts.artifactDir,
    name: opts.name,
  });
  return parts;
}

export function buildSubagentCommand(opts: {
  cwd?: string | null;
  envParts: string[];
  parts: string[];
}): string {
  const cdPrefix = opts.cwd ? `cd ${shellEscape(opts.cwd)} && ` : "";
  const envPrefix =
    opts.envParts.length > 0 ? `${opts.envParts.join(" ")} ` : "";
  const piCommand = `${cdPrefix}${envPrefix}${opts.parts.join(" ")}`;
  return `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
}
