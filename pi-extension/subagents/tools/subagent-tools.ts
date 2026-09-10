/**
 * Tool and command registration for the orchestrator side.
 *
 * All tools are fire-and-forget: `subagent` returns at spawn time and the
 * outcome arrives later as a steered message, so callers must never poll.
 * Spawns are guarded three ways: self-spawn refusal, spawn-allowlist
 * check, and tmux availability. Display names are reserved between
 * uniqueness assignment and map insertion so concurrent spawns cannot
 * claim the same name. Global state stays owned by `index.ts` and arrives
 * via `SubagentToolDeps`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { isMuxAvailable, muxSetupHint } from "../tmux.ts";
import {
  loadAgentDefaults,
  discoverAgentDefinitions,
  SUBAGENT_ALLOWLIST,
  type ListedAgentDefinition,
} from "../agents/discovery.ts";
import {
  getSessionId,
  registerName,
  readNameRegistry,
  resolveNameInRegistry,
} from "../session.ts";
import { getArtifactDir } from "../lifecycle/seed.ts";
import { launchSubagent, type LaunchContext } from "../lifecycle/launch.ts";
import { resumeSubagent } from "../lifecycle/resume.ts";
import { handleSubagentSteer } from "../lifecycle/steer.ts";
import {
  attachSubagentWatcher,
  startStatusSupervision,
  startWidgetRefreshLater,
} from "../lifecycle/dispatcher.ts";
import type { RunningSubagent } from "../index.ts";

export const SubagentParams = Type.Object({
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

/**
 * Assigns the first free display name: `worker`, then `worker-2`,
 * `worker-3`, and so on. Suffixes start at 2 so the bare base name stays
 * the common case.
 *
 * @param base Preferred display name.
 * @param takenNames Names already claimed.
 * @returns Base name when free, otherwise the lowest free suffixed form.
 */
export function computeUniqueName(
  base: string,
  takenNames: Set<string>,
): string {
  if (!takenNames.has(base)) return base;
  let n = 2;
  while (takenNames.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Transient spawn reservations. A name is held from uniqueness assignment
 * until the record lands in the running map, closing the race where two
 * concurrent spawns compute the same free name.
 */
const reservedNames = new Set<string>();

function uniqueRunningName(
  runningSubagents: Map<string, RunningSubagent>,
  base: string,
  registryNames?: Set<string>,
): string {
  const taken = new Set(
    Array.from(runningSubagents.values()).map((r) => r.name),
  );
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  return computeUniqueName(base, taken);
}

export interface SubagentToolDeps {
  runningSubagents: Map<string, RunningSubagent>;
  updateWidget: () => void;
  getPi: () => ExtensionAPI | null;
}

/**
 * Registers the `subagent` spawn tool (fire-and-forget with steered result).
 *
 * @param pi Extension host for tool registration.
 * @param deps Running map, widget refresh, and live parent handle.
 */
export function registerSubagentTool(
  pi: ExtensionAPI,
  deps: SubagentToolDeps,
): void {
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
        deps.runningSubagents,
        requestedName || params.agent,
        registryNames,
      );
      reservedName = params.name;
      reservedNames.add(reservedName);

      let running: RunningSubagent;
      try {
        running = await launchSubagent(
          params,
          ctx as LaunchContext,
          deps.runningSubagents,
        );
      } finally {
        if (reservedName) reservedNames.delete(reservedName);
      }

      registerName(parentArtifactDir, running.name, {
        sessionFile: running.sessionFile,
        sessionId: getSessionId(running.sessionFile),
      });

      const dispatcherDeps = {
        runningSubagents: deps.runningSubagents,
        updateWidget: deps.updateWidget,
        getPi: deps.getPi,
      };
      startWidgetRefreshLater(dispatcherDeps);
      startStatusSupervision(dispatcherDeps);

      attachSubagentWatcher(running, pi, dispatcherDeps, { isResume: false });

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
}

/**
 * Registers the read-only `subagents_list` catalog tool. Takes no deps
 * because discovery reads the filesystem on every call.
 *
 * @param pi Extension host for tool registration.
 */
export function registerSubagentsListTool(pi: ExtensionAPI): void {
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
}

/**
 * Registers `subagent_message`: steers a running pane by name, otherwise
 * resumes the finished session behind that name. Steering is exact-name
 * first; a pane already tracking the same session file wins over a resume.
 *
 * @param pi Extension host for tool registration.
 * @param deps Running map, widget refresh, and live parent handle.
 */
export function registerSubagentMessageTool(
  pi: ExtensionAPI,
  deps: SubagentToolDeps,
): void {
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

      const runningMatch = Array.from(deps.runningSubagents.values()).find(
        (r) => r.name === requestedName,
      );
      if (runningMatch) {
        return handleSubagentSteer(
          {
            name: requestedName,
            message: params.message,
          },
          {
            runningSubagents: deps.runningSubagents,
            updateWidget: deps.updateWidget,
          },
        );
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
      for (const running of deps.runningSubagents.values()) {
        if (resolve(running.sessionFile) === resolve(entry.sessionFile)) {
          return handleSubagentSteer(
            {
              name: running.name,
              message: params.message,
            },
            {
              runningSubagents: deps.runningSubagents,
              updateWidget: deps.updateWidget,
            },
          );
        }
      }
      return resumeSubagent(
        requestedName,
        params.message,
        entry,
        parentArtifactDir,
        ctx as LaunchContext,
        pi,
        deps.runningSubagents,
        { updateWidget: deps.updateWidget, getPi: deps.getPi },
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
}

/**
 * Registers the `/subagent <agent> [task]` slash command. Validates the
 * agent name, then delegates to the `subagent` tool via a user message so
 * spawning flows through the same guards.
 *
 * @param pi Extension host for command registration and messaging.
 */
export function registerSubagentCommand(pi: ExtensionAPI): void {
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
}
