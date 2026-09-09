/**
 * Interactive subagents extension for pi.
 *
 * Spawns subagents in dedicated tmux panes and steers execution results
 * back to the orchestrator session as messages.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendCommand,
  sendLongCommand,
  closeSurface,
  shellEscape,
} from "./tmux.ts";
import {
  getSessionId,
  seedSubagentSessionFile,
  readSubagentLoadout,
  writeSubagentLoadout,
  type SubagentLoadout,
  type SessionStats,
  registerName,
  readNameRegistry,
  resolveNameInRegistry,
  type NameRegistryEntry,
} from "./session.ts";
import {
  readSubagentActivityFile,
  getSubagentActivityFile,
  type SubagentActivityState,
} from "./activity.ts";
import { buildToolAllowlist, sanitizeSubagentName } from "./sandbox.ts";
import { parseEnvInt } from "./env.ts";

import { publishRunningChildrenCount } from "./registry.ts";

publishRunningChildrenCount(() => runningSubagents.size);

// ── Agent discovery (re-exported; implementation lives in ./agents/discovery.ts) ──
export {
  getAgentConfigDir,
  getBundledAgentsDir,
  getFrontmatterValue,
  parseCommaList,
  parseOptionalBoolean,
  parseSystemPromptMode,
  parseAgentDefinition,
  loadAgentDefaults,
  discoverAgentDefinitions,
  SUBAGENT_ALLOWLIST,
  type AgentDefaults,
  type ListedAgentDefinition,
} from "./agents/discovery.ts";
import {
  loadAgentDefaults,
  discoverAgentDefinitions,
  SUBAGENT_ALLOWLIST,
  type ListedAgentDefinition,
} from "./agents/discovery.ts";

export interface SubagentLaunchDetails {
  id?: string;
  name?: string;
  task?: string;
  agent?: string;
  sessionFile?: string;
  status?: "started";
  error?: string;
}

export interface SubagentsListDetails {
  agents?: ListedAgentDefinition[];
}

export interface SubagentMessageDetails {
  id?: string;
  name?: string;
  sessionId?: string;
  sessionFile?: string;
  launchScriptFile?: string;
  status?: "steered" | "started";
  error?: string;
}

export interface SubagentResultDetails {
  name?: string;
  task?: string;
  agent?: string;
  exitCode?: number;
  elapsed?: number;
  sessionFile?: string;
  sessionId?: string;
  errorMessage?: string;
  stats?: SessionStats;
  toolCount?: number;
  error?: string;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Cosmetic label for the subagent's pane and widget row. Defaults to the agent name. " +
        "Has no effect on which agent runs — use `agent` for that.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, skills, and extensions.",
    }),
  ),
});

// ── Paths, env/CLI builders & artifacts (re-exported; see ./lifecycle/seed.ts, ./cli/args.ts) ──
export {
  getArtifactDir,
  getDefaultSessionDirFor,
  resolveSubagentPaths,
  composeSubagentTask,
  buildSkillPromptArgs,
  writeTaskArtifact,
  writeResumeMessageArtifact,
} from "./lifecycle/seed.ts";
export {
  buildSubagentEnv,
  buildScriptPreamble,
  buildSubagentCliParts,
  buildSubagentCommand,
  type SubagentEnvOptions,
  type SubagentCliOptions,
} from "./cli/args.ts";
import {
  getArtifactDir,
  getDefaultSessionDirFor,
  resolveSubagentPaths,
  composeSubagentTask,
  buildSkillPromptArgs,
  writeTaskArtifact,
  writeResumeMessageArtifact,
} from "./lifecycle/seed.ts";
import {
  buildSubagentEnv,
  buildScriptPreamble,
  buildSubagentCliParts,
  buildSubagentCommand,
} from "./cli/args.ts";

// ── Runtime state ──

export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  launchScriptFile?: string;
  abortController?: AbortController;
  interactive: boolean;
}

const runningSubagents = new Map<string, RunningSubagent>();
const reservedNames = new Set<string>();

let latestCtx: ExtensionContext | null = null;
let latestPi: ExtensionAPI | null = null;

export function computeUniqueName(
  base: string,
  takenNames: Set<string>,
): string {
  if (!takenNames.has(base)) return base;
  let n = 2;
  while (takenNames.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(
    Array.from(runningSubagents.values()).map((r) => r.name),
  );
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  return computeUniqueName(base, taken);
}

export function findSubagentByName<T extends { id: string; name: string }>(
  items: T[],
  requestedName: string,
): { found: T } | { error: string } {
  const trimmed = requestedName.trim();
  if (!trimmed)
    return { error: "Provide the exact display name of a running subagent." };
  const lower = trimmed.toLowerCase();
  let matches = items.filter((r) => r.name === trimmed);
  if (matches.length === 0) {
    matches = items.filter((r) => r.name.toLowerCase() === lower);
  }
  if (matches.length === 1) return { found: matches[0] };
  if (matches.length === 0) {
    const names = items.map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${trimmed}".${hint}` };
  }
  const candidates = matches.map((r) => `${r.name} [${r.id}]`).join(", ");
  return {
    error: `Ambiguous subagent name "${trimmed}". Matches: ${candidates}`,
  };
}

function resolveRunningByName(
  name: string,
): { running: RunningSubagent } | { error: string } {
  const result = findSubagentByName(
    Array.from(runningSubagents.values()),
    name,
  );
  if ("error" in result) return { error: result.error };
  return { running: result.found };
}

// ── Formatting ──

// ── Formatting & widgets (re-exported; implementation lives in ./tui/widgets.ts) ──
export {
  formatElapsed,
  borderLine,
  borderTop,
  borderBottom,
  statusLabelFor,
  renderSubagentWidgetLines,
  resolveResultPresentation,
  statusConfig,
  type WidgetAgentRow,
  type SubagentResult,
} from "./tui/widgets.ts";
import {
  formatElapsed,
  renderSubagentWidgetLines,
  resolveResultPresentation,
  statusConfig,
} from "./tui/widgets.ts";

function getShellReadyDelayMs(): number {
  return parseEnvInt(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS, 500, 0);
}

// ── Widget ──

function updateWidget(): void {
  if (!latestCtx?.hasUI) return;
  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    return;
  }
  latestCtx.ui.setWidget(
    "subagent-status",
    () => ({
      invalidate() {},
      render(width: number) {
        return renderSubagentWidgetLines(
          Array.from(runningSubagents.values()),
          width,
        );
      },
    }),
    { placement: "aboveEditor" },
  );
}

let statusTimer: ReturnType<typeof setInterval> | null = null;
function startStatusSupervision(): void {
  if (!statusConfig.enabled || statusTimer) return;
  statusTimer = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      return;
    }
    for (const running of runningSubagents.values()) {
      if (!running.activityFile) continue;
      const read = readSubagentActivityFile(running.activityFile, running.id);
      if (read.ok) running.activity = read.activity;
    }
    updateWidget();
  }, 2000);
}

// ── Watcher Completion Dispatcher ──

export function attachSubagentWatcher(
  running: RunningSubagent,
  pi: ExtensionAPI,
  options?: {
    sessionId?: string | null;
    isResume?: boolean;
    onCompleted?: () => void;
  },
): void {
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;

  watchSubagent(running, watcherAbort.signal, {
    getPi: () => latestPi,
    removeRunning: (id) => {
      runningSubagents.delete(id);
    },
  })
    .then((result) => {
      options?.onCompleted?.();
      updateWidget();
      const sessionId = options?.sessionId ?? result.sessionId;
      let summary = result.summary;
      if (options?.isResume && summary === "Sub-agent exited without output") {
        summary = "Resumed session exited without new output";
      } else if (
        options?.isResume &&
        summary.startsWith("Sub-agent exited with code ")
      ) {
        summary = `Resumed session exited with code ${result.exitCode}`;
      }

      pi.sendMessage(
        {
          customType: "subagent_result",
          content: resolveResultPresentation({ ...result, summary, sessionId }),
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            exitCode: result.exitCode,
            elapsed: result.elapsed,
            sessionFile: result.sessionFile,
            ...(sessionId ? { sessionId } : {}),
            ...(result.errorMessage
              ? { errorMessage: result.errorMessage }
              : {}),
            ...(result.stats ? { stats: result.stats } : {}),
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .catch((err) => {
      options?.onCompleted?.();
      updateWidget();
      const prefix = options?.isResume
        ? "Resume"
        : `Sub-agent "${running.name}"`;
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `${prefix} error: ${err?.message ?? String(err)}`,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            error: err?.message,
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });
}

// ── Launch ──

interface LaunchContext {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
}

async function launchSubagent(
  params: Static<typeof SubagentParams>,
  ctx: LaunchContext,
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

  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: buildScriptPreamble(
      "launch",
      effectiveName,
      subagentSessionFile,
      surface,
    ),
  });

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

// ── Watch (re-exported; implementation lives in ./lifecycle/watch.ts) ──
export {
  watchSubagent,
  getWatchTimeoutMs,
  type WatchedSubagent,
  type WatchDeps,
  type SubagentQuestionDetails,
} from "./lifecycle/watch.ts";
import {
  watchSubagent,
  type SubagentQuestionDetails,
} from "./lifecycle/watch.ts";

// ── Steer ──

export function steerSubagent(
  running: RunningSubagent,
  message: string,
): { ok: true } | { error: string } {
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();
  try {
    sendCommand(running.surface, flattened);
    return { ok: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { error: `Failed to deliver message to "${running.name}": ${msg}` };
  }
}

function handleSubagentSteer(params: { name?: string; message?: string }) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err },
    };
  }
  const resolved = resolveRunningByName(params.name ?? "");
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }
  const running = resolved.running;
  const steer = steerSubagent(running, message);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }
  updateWidget();
  return {
    content: [
      {
        type: "text" as const,
        text: `Message delivered to running subagent "${running.name}". It picks this up at its next turn boundary.`,
      },
    ],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

// ── Resume ──

function resumeSubagent(
  name: string,
  message: string | undefined,
  entry: NameRegistryEntry,
  parentArtifactDir: string,
  ctx: LaunchContext,
  pi: ExtensionAPI,
): {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentMessageDetails;
} {
  const sessionPath = entry.sessionFile;
  const loadout = readSubagentLoadout(sessionPath);
  if (!loadout) {
    const err =
      `Cannot safely resume "${name}": no sandbox snapshot found. Resuming would relaunch with all ` +
      `global extensions and the full toolset, so this is refused. Re-run the task as a fresh subagent.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err },
    };
  }

  const id = Math.random().toString(16).slice(2, 10);
  const startTime = Date.now();
  const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? name;
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    sessionId,
  );
  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  const surface = createSurface(name);
  startStatusSupervision();
  void startWidgetRefreshLater();

  const parts = buildSubagentCliParts(sessionPath, loadout, {
    artifactDir,
    name,
  });

  let resumeMsgFile: string | undefined;
  if (message) {
    resumeMsgFile = writeResumeMessageArtifact(artifactDir, name, message);
    parts.push(shellEscape(`@${resumeMsgFile}`));
  }

  const envParts = buildSubagentEnv({
    surface,
    sessionFile: sessionPath,
    id,
    name,
    activityFile,
    agent: loadout.agent,
    agentDir: loadout.agentDir,
    allowedAgents: loadout.spawnable,
    autoExit: true,
  });

  const command = buildSubagentCommand({
    cwd: loadout.cwd,
    envParts,
    parts,
  });

  const safeName = sanitizeSubagentName(name, "resume");
  const launchScriptFile = join(
    artifactDir,
    "subagent-scripts",
    `${safeName}-resume-${Date.now()}.sh`,
  );
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: buildScriptPreamble("resume", name, sessionPath, surface),
  });

  const running: RunningSubagent = {
    id,
    name,
    task: message ?? "",
    agent: loadout.agent ?? undefined,
    surface,
    startTime,
    sessionFile: sessionPath,
    launchScriptFile,
    activityFile,
    interactive: false,
  };
  runningSubagents.set(id, running);

  attachSubagentWatcher(running, pi, {
    isResume: true,
    sessionId: resumedSessionId,
  });

  return {
    content: [{ type: "text" as const, text: `Session "${name}" resumed.` }],
    details: {
      id,
      name,
      sessionId: resumedSessionId,
      sessionFile: sessionPath,
      launchScriptFile,
      status: "started",
    },
  };
}

let widgetTimer: ReturnType<typeof setInterval> | null = null;
function startWidgetRefreshLater(): void {
  if (widgetTimer) return;
  updateWidget();
  widgetTimer = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (widgetTimer) clearInterval(widgetTimer);
      widgetTimer = null;
      return;
    }
    updateWidget();
  }, 2000);
}

// ── Extension ──

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    for (const agent of runningSubagents.values()) {
      agent.abortController?.abort();
      try {
        closeSurface(agent.surface);
      } catch {
        // Pane may already be gone if the subagent exited before shutdown.
      }
    }
    runningSubagents.clear();
  });

  // ── subagent tool ──
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a sub-agent in a dedicated tmux pane. Fire-and-forget: the call returns immediately and the " +
      "result is steered back as a message when the sub-agent finishes. Do NOT poll or wait for completion — " +
      "the harness delivers it for you.",
    parameters: SubagentParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const currentAgent = process.env.PI_SUBAGENT_AGENT;
      if (params.agent && currentAgent && params.agent === currentAgent) {
        const err = `You are the ${currentAgent} agent — do not start another ${currentAgent}. Complete the task directly.`;
        return {
          content: [{ type: "text" as const, text: err }],
          details: { error: "self-spawn blocked" },
        };
      }

      const permittedAgents = SUBAGENT_ALLOWLIST
        ? [...SUBAGENT_ALLOWLIST]
        : discoverAgentDefinitions().map((a) => a.name);
      const permittedSet = new Set(permittedAgents);
      const permittedList = permittedAgents.join(", ") || "(none)";

      if (!params.agent) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Specify an agent via "agent". Available: ${permittedList}.`,
            },
          ],
          details: { error: "agent required" },
        };
      }
      if (!permittedSet.has(params.agent)) {
        const msg = `You may not spawn "${params.agent}" — it is not ${SUBAGENT_ALLOWLIST ? "in your allowlist" : "a known agent"}. Available: ${permittedList}.`;
        return {
          content: [{ type: "text" as const, text: msg }],
          details: { error: "agent not permitted" },
        };
      }

      if (!isMuxAvailable()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Subagents require tmux. ${muxSetupHint()}`,
            },
          ],
          details: { error: "tmux not available" },
        };
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: no session file. Start pi with a persistent session to use subagents.",
            },
          ],
          details: { error: "no session file" },
        };
      }

      const parentArtifactDir = getArtifactDir(
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      );

      let reservedName: string | null = null;
      const requestedName = params.name?.trim();
      const registryNames = new Set(
        Object.keys(readNameRegistry(parentArtifactDir)),
      );
      params.name = uniqueRunningName(
        requestedName || params.agent,
        registryNames,
      );
      reservedName = params.name;
      reservedNames.add(reservedName);

      let running: RunningSubagent;
      try {
        running = await launchSubagent(params, ctx as LaunchContext);
      } finally {
        if (reservedName) reservedNames.delete(reservedName);
      }

      registerName(parentArtifactDir, running.name, {
        sessionFile: running.sessionFile,
        sessionId: getSessionId(running.sessionFile),
      });

      startWidgetRefreshLater();
      startStatusSupervision();

      attachSubagentWatcher(running, pi, { isResume: false });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Sub-agent "${params.name}" launched and is now running in the background. ` +
              `Do NOT generate or assume results — you will be notified when it finishes. ` +
              `Move on to other work or tell the user you're waiting.`,
          },
        ],
        details: {
          id: running.id,
          name: params.name,
          task: params.task,
          agent: params.agent,
          sessionFile: running.sessionFile,
          status: "started",
        },
      };
    },

    renderResult(result, _opts, theme) {
      const details = result.details as SubagentLaunchDetails | undefined;
      const name = details?.name ?? "(unnamed)";
      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "⟳") +
            " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — started"),
          0,
          0,
        );
      }
      const firstContent = result.content[0];
      const text =
        firstContent &&
        "text" in firstContent &&
        typeof firstContent.text === "string"
          ? firstContent.text
          : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });

  // ── subagents_list tool ──
  pi.registerTool({
    name: "subagents_list",
    label: "List Subagents",
    description:
      "List available subagent definitions (project > global > package).",
    parameters: Type.Object({}),
    async execute() {
      const list = discoverAgentDefinitions().filter(
        (a) => !a.disableModelInvocation,
      );
      if (list.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No subagent definitions found." },
          ],
          details: { agents: [] },
        };
      }
      const lines = list.map((a) => {
        const badge = a.source === "project" ? " (project)" : "";
        const desc = a.description ? ` — ${a.description}` : "";
        const model = a.model ? ` [${a.model}]` : "";
        return `• ${a.name}${badge}${model}${desc}`;
      });
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { agents: list },
      };
    },
    renderResult(result, _opts, theme) {
      const details = result.details as SubagentsListDetails | undefined;
      const agents = details?.agents ?? [];
      if (agents.length === 0)
        return new Text(
          theme.fg("dim", "No subagent definitions found."),
          0,
          0,
        );
      const lines = agents.map((a: ListedAgentDefinition) => {
        const badge =
          a.source === "project" ? theme.fg("accent", " (project)") : "";
        const desc = a.description
          ? theme.fg("dim", ` — ${a.description}`)
          : "";
        const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
        return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── subagent_message tool ──
  pi.registerTool({
    name: "subagent_message",
    label: "Message Subagent",
    description:
      "Send a message to a subagent by name. Steers a running subagent; resumes a finished one (same name either way). " +
      "`name` and `message` are required. Steering returns immediately; resuming delivers its result later as a steer message.",
    parameters: Type.Object({
      name: Type.String({ description: "Exact display name of the subagent." }),
      message: Type.String({
        description:
          "The message to deliver or the next task for a resumed session.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requestedName = params.name?.trim();
      if (!requestedName) {
        const err = "Provide the subagent's `name` to steer or resume.";
        return {
          content: [{ type: "text" as const, text: err }],
          details: { error: err },
        };
      }
      if (!isMuxAvailable()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Subagents require tmux. ${muxSetupHint()}`,
            },
          ],
          details: { error: "tmux not available" },
        };
      }

      const runningMatch = Array.from(runningSubagents.values()).find(
        (r) => r.name === requestedName,
      );
      if (runningMatch) {
        return handleSubagentSteer({
          name: requestedName,
          message: params.message,
        });
      }

      if (!params.message?.trim()) {
        const err = "`message` is required to resume a finished subagent.";
        return {
          content: [{ type: "text" as const, text: err }],
          details: { error: err },
        };
      }

      const parentArtifactDir = getArtifactDir(
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      );
      const entry = resolveNameInRegistry(parentArtifactDir, requestedName);
      if (!entry) {
        const known = Object.keys(readNameRegistry(parentArtifactDir));
        const err = `No subagent named "${requestedName}" in this session. ${known.length > 0 ? `Known: ${known.join(", ")}.` : "None have been spawned yet."}`;
        return {
          content: [{ type: "text" as const, text: err }],
          details: { error: err },
        };
      }
      if (!entry.sessionFile || !existsSync(entry.sessionFile)) {
        const err = `Subagent "${requestedName}" is registered but its session file is gone. Spawn a fresh subagent instead.`;
        return {
          content: [{ type: "text" as const, text: err }],
          details: { error: err },
        };
      }
      for (const running of runningSubagents.values()) {
        if (resolve(running.sessionFile) === resolve(entry.sessionFile)) {
          return handleSubagentSteer({
            name: running.name,
            message: params.message,
          });
        }
      }
      return resumeSubagent(
        requestedName,
        params.message,
        entry,
        parentArtifactDir,
        ctx as LaunchContext,
        pi,
      );
    },
    renderResult(result, _opts, theme) {
      const details = result.details as SubagentMessageDetails | undefined;
      if (details?.status === "steered") {
        return new Text(
          theme.fg("success", "✓") +
            " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
            theme.fg("dim", " — message delivered"),
          0,
          0,
        );
      }
      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "⟳") +
            " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
            theme.fg("dim", " — resumed"),
          0,
          0,
        );
      }
      const firstContent = result.content[0];
      const text =
        firstContent &&
        "text" in firstContent &&
        typeof firstContent.text === "string"
          ? firstContent.text
          : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });

  // ── /subagent command ──
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }
      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }
      const taskText =
        task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      pi.sendUserMessage(
        `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`,
      );
    },
  });

  // ── Result renderer ──
  pi.registerMessageRenderer(
    "subagent_question",
    (message, _options, theme) => {
      const details = message.details as SubagentQuestionDetails | undefined;
      if (!details) return undefined;
      return {
        invalidate() {},
        render(width: number): string[] {
          const name = details.name ?? "subagent";
          const question = details.question ?? "";
          const box = new Box(1, 1, (text: string) =>
            theme.bg("customMessageBg", text),
          );
          const icon = theme.fg("warning", "?");
          const title = `${icon} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("warning", "is asking a question:")}`;
          const lines = [
            title,
            "",
            theme.fg("dim", question),
            "",
            theme.fg(
              "muted",
              `Reply with subagent_message({ name: "${name}", message: "..." })`,
            ),
          ];
          box.addChild(new Text(lines.join("\n"), 0, 0));
          return ["", ...box.render(width)];
        },
      };
    },
  );

  pi.registerMessageRenderer("subagent_result", (message, _options, theme) => {
    const details = message.details as SubagentResultDetails | undefined;
    if (!details) return undefined;
    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const failed = (details.exitCode ?? 0) !== 0 || !!details.errorMessage;
        const elapsed =
          details.elapsed == null ? "?" : formatElapsed(details.elapsed);
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const title = `${icon} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", "—")} `;
        const toolCount = details.stats?.toolCount ?? details.toolCount ?? 0;
        const header = failed
          ? `${title}${theme.fg("error", details.errorMessage ? "failed (provider/agent error)" : `failed (exit ${details.exitCode})`)} ${theme.fg("dim", `· ${elapsed}`)}`
          : `${title}${theme.fg("dim", `${toolCount} tools · ${elapsed}`)}`;
        const rawContent =
          typeof message.content === "string" ? message.content : "";
        const summary = rawContent.replace(
          /\n\nFollow up with subagent_message[\s\S]+$/,
          "",
        );
        const contentLines = [header];
        if (summary) {
          for (const line of summary.split("\n"))
            contentLines.push(line.slice(0, width - 4));
        }
        contentLines.push(
          theme.fg("muted", keyHint("app.tools.expand", "to expand")),
        );
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}
