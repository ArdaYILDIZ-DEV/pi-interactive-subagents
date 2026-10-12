/**
 * Subagent launch: resolves the agent profile, snapshots the sandbox
 * loadout, and boots the child `pi` process in a new tmux pane.
 *
 * Pipeline per spawn: profile defaults -> working directory -> session
 * file -> parent/child seed record -> tool allowlist and CLI command ->
 * generated launch script executed via `sendLongCommand` (script files
 * avoid terminal line-wrapping truncation of long commands).
 * Global state stays in `index.ts`; the running map is injected.
 */
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { closeSurface, createSurface, sendLongCommand, shellEscape } from "../tmux.ts";
import {
  seedSubagentSessionFile,
  writeSubagentLoadout,
  type SubagentLoadout,
} from "../session.ts";
import { getSubagentActivityFile } from "../activity.ts";
import { buildToolAllowlist, sanitizeSubagentName } from "../sandbox.ts";
import { parseEnvInt } from "../env.ts";
import { loadAgentDefaults } from "../agents/discovery.ts";
import {
  getArtifactDir,
  resolveSubagentPaths,
  composeSubagentTask,
  buildSkillPromptArgs,
  writeTaskArtifact,
} from "./seed.ts";
import {
  buildSubagentEnv,
  buildScriptPreamble,
  buildSubagentCliParts,
  buildSubagentCommand,
} from "../cli/args.ts";
import type { RunningSubagent } from "../index.ts";
import { createPiSubagentSession, readPiParentSession, type PiSessionContext } from "../pi-compat.ts";

export type LaunchContext = PiSessionContext;

/** Cancellation and runtime-liveness controls for an in-flight launch. */
export interface LaunchControl {
  signal?: AbortSignal;
  isActive?: () => boolean;
}

export function assertLaunchActive(control?: LaunchControl): void {
  if (control?.signal?.aborted || (control?.isActive && !control.isActive())) {
    throw new Error("Subagent launch cancelled: the request or extension runtime is no longer active.");
  }
}

function waitForShellReady(control?: LaunchControl): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = control?.signal;
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Subagent launch cancelled during the shell-ready delay."));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, getShellReadyDelayMs());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Launch inputs. `name` is normalized in place to the effective display
 * name, so callers must treat `params` as mutated on success.
 */
export interface LaunchParams {
  agent?: string;
  task: string;
  name?: string;
  model?: string;
  cwd?: string;
}

/**
 * Shell handoff delay giving the fresh pane time to present a prompt
 * before the launch script is pasted. Tunable via
 * `PI_SUBAGENT_SHELL_READY_DELAY_MS`.
 */
function getShellReadyDelayMs(): number {
  return parseEnvInt(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS, 500, 0);
}

/**
 * Boots one subagent pane and registers it in the running map.
 *
 * @param params Agent, task, and optional name/model/cwd overrides.
 * @param ctx Parent session handles plus orchestrator working directory.
 * @param runningSubagents Extension-owned map receiving the new record.
 * @returns The tracked running subagent.
 * @throws When the parent session has no session file.
 */
export async function launchSubagent(
  params: LaunchParams,
  ctx: LaunchContext,
  runningSubagents: Map<string, RunningSubagent>,
  control?: LaunchControl,
): Promise<RunningSubagent> {
  assertLaunchActive(control);
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveAutoExit = agentDefs?.autoExit ?? true;
  const effectiveInteractive = agentDefs?.interactive ?? !effectiveAutoExit;

  const parent = readPiParentSession(ctx);
  const sessionFile = parent.sessionFile;
  if (!sessionFile) throw new Error("No session file");
  const artifactDir = getArtifactDir(parent.sessionDir, parent.sessionId);

  const { effectiveCwd, effectiveAgentDir } = resolveSubagentPaths(
    params,
    agentDefs,
  );
  const targetCwd = effectiveCwd ?? parent.cwd;
  const child = createPiSubagentSession(targetCwd, effectiveAgentDir, sessionFile);
  const subagentSessionFile = child.sessionFile;

  const effectiveName = params.name?.trim() || params.agent || "subagent";
  params.name = effectiveName;

  // Record the parent→child relationship so subagent_message can locate this session by name later.
  seedSubagentSessionFile({
    parentSessionFile: sessionFile,
    childSessionFile: subagentSessionFile,
    childCwd: targetCwd,
    header: child.header,
  });

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  const grantSpawning = !!(
    agentDefs?.subagentAgents && agentDefs.subagentAgents.length > 0
  );
  const toolAllowlist = buildToolAllowlist(effectiveTools, { grantSpawning });
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = !!(systemPromptMode && identity);

  const loadout: SubagentLoadout = {
    agent: params.agent ?? null,
    toolAllowlist,
    model: effectiveModel ?? null,
    thinking: effectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    spawnable: agentDefs?.subagentAgents ?? null,
    autoExit: effectiveAutoExit,
    cwd: targetCwd,
    agentDir: effectiveAgentDir,
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  const fullTask = composeSubagentTask({
    task: params.task,
    autoExit: effectiveAutoExit,
    identity,
    systemPromptMode,
  });

  const parts = buildSubagentCliParts(subagentSessionFile, loadout, {
    artifactDir,
    name: effectiveName,
  });

  const taskPath = writeTaskArtifact(artifactDir, effectiveName, fullTask);
  const skillArgs = buildSkillPromptArgs(effectiveSkills);
  for (const arg of [...skillArgs, `@${taskPath}`]) {
    parts.push(shellEscape(arg));
  }

  const safeName = sanitizeSubagentName(effectiveName, "subagent");
  const launchScriptFile = join(artifactDir, "subagent-scripts", `${safeName}-${id}.sh`);

  assertLaunchActive(control);
  const surface = createSurface(effectiveName);
  try {
    await waitForShellReady(control);
    assertLaunchActive(control);
    const envParts = buildSubagentEnv({
      surface,
      sessionFile: subagentSessionFile,
      id,
      name: effectiveName,
      activityFile,
      agent: params.agent,
      agentDir: effectiveAgentDir,
      allowedAgents: agentDefs?.subagentAgents,
      autoExit: effectiveAutoExit,
    });

    const command = buildSubagentCommand({
      cwd: targetCwd,
      envParts,
      parts,
    });

    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: buildScriptPreamble(
        "launch",
        effectiveName,
        subagentSessionFile,
        surface,
      ),
    });
    assertLaunchActive(control);

    const running: RunningSubagent = {
      id,
      name: effectiveName,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      activityFile,
      interactive: effectiveInteractive,
    };
    runningSubagents.set(id, running);
    return running;
  } catch (error: unknown) {
    try {
      closeSurface(surface, control?.isActive?.() !== false);
    } catch {
      // Cleanup is best-effort if the multiplexer itself is unavailable.
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start subagent "${effectiveName}" (${surface}): ${detail}. Pane cleanup was attempted.`);
  }
}
