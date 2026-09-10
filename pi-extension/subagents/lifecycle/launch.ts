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
  getDefaultSessionDirFor,
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

export interface LaunchContext {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
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
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveAutoExit = agentDefs?.autoExit ?? true;
  const effectiveInteractive = agentDefs?.interactive ?? !effectiveAutoExit;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    sessionId,
  );

  const { effectiveCwd, effectiveAgentDir } = resolveSubagentPaths(
    params,
    agentDefs,
  );
  const targetCwd = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwd, effectiveAgentDir);

  const timestamp =
    new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const effectiveName = params.name?.trim() || params.agent || "subagent";
  params.name = effectiveName;

  // Split from the parent pane so the new pane appears alongside it without stealing keyboard focus.
  const surface = createSurface(effectiveName);
  await new Promise<void>((resolve) =>
    setTimeout(resolve, getShellReadyDelayMs()),
  );

  // Record the parent→child relationship so subagent_message can locate this session by name later.
  seedSubagentSessionFile({
    parentSessionFile: sessionFile,
    childSessionFile: subagentSessionFile,
    childCwd: targetCwd,
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
    cwd: effectiveCwd ?? null,
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
    cwd: effectiveCwd,
    envParts,
    parts,
  });

  const safeName = sanitizeSubagentName(effectiveName, "subagent");
  const launchScriptName = `${safeName}-${id}.sh`;
  const launchScriptFile = join(
    artifactDir,
    "subagent-scripts",
    launchScriptName,
  );

  try {
    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: buildScriptPreamble(
        "launch",
        effectiveName,
        subagentSessionFile,
        surface,
      ),
    });
  } catch (error: unknown) {
    // The fresh pane died between split and send (or tmux itself failed).
    // Without cleanup this leaks an orphan pane no watcher will ever close,
    // and without wrapping the raw tmux stderr reaches the user unframed.
    try {
      closeSurface(surface);
    } catch {
      // Pane already gone; cleanup was best-effort.
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to start subagent "${effectiveName}": its tmux pane (${surface}) went away before the launch command could be delivered (${detail}). The orphan pane was cleaned up; retry the spawn.`,
    );
  }

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
}
