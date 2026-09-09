/**
 * Session seed / artifact helpers (extracted from `index.ts` — pure move, no behavior change).
 */
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { sanitizeSubagentName } from "../sandbox.ts";
import { getAgentConfigDir, type AgentDefaults } from "../agents/discovery.ts";

// ── Paths ──

export function getArtifactDir(sessionDir: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[/\\.\0]/g, "-");
  return join(sessionDir, "artifacts", safeSessionId || "default");
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

export function resolveSubagentPaths(
  params: { cwd?: string },
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdBase =
    !params.cwd && agentDefs?.cwd != null ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd
    ? join(effectiveCwd, ".pi", "agent")
    : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : getAgentConfigDir();
  return { effectiveCwd, effectiveAgentDir };
}

// ── Artifact Writers and Prompt Builders ──

export function composeSubagentTask(params: {
  task: string;
  autoExit: boolean;
  identity?: string | null;
  systemPromptMode?: "append" | "replace";
}): string {
  const modeHint = params.autoExit
    ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = params.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  const identity = params.identity ?? null;
  const identityInSystemPrompt = params.systemPromptMode && identity;
  const roleBlock =
    identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  return `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
}

export function buildSkillPromptArgs(skills?: string): string[] {
  const skillPrompts = (skills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);
  return skillPrompts.length > 0 ? ["", ...skillPrompts] : [];
}

export function writeTaskArtifact(
  artifactDir: string,
  name: string,
  fullTask: string,
  timestamp?: string,
): string {
  const taskTimestamp =
    timestamp ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = sanitizeSubagentName(name, "subagent");
  const taskPath = join(artifactDir, `context/${safeName}-${taskTimestamp}.md`);
  mkdirSync(dirname(taskPath), { recursive: true });
  writeFileSync(taskPath, fullTask, "utf8");
  return taskPath;
}

export function writeResumeMessageArtifact(
  artifactDir: string,
  name: string,
  message: string,
  timestamp?: string,
): string {
  const msgTimestamp =
    timestamp ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = sanitizeSubagentName(name, "resume");
  const resumeMsgFile = join(
    artifactDir,
    "subagent-resume",
    `${safeName}-${msgTimestamp}.md`,
  );
  mkdirSync(dirname(resumeMsgFile), { recursive: true });
  writeFileSync(resumeMsgFile, message, "utf8");
  return resumeMsgFile;
}
