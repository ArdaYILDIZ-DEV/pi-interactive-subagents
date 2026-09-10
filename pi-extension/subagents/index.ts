/**
 * Interactive subagents extension for pi (entry point).
 *
 * Owns the extension-global state (`runningSubagents`, `latestCtx`, `latestPi`)
 * and wires it into the feature modules via dependency injection. Spawns
 * subagents in dedicated tmux panes and steers execution results back to the
 * orchestrator session as messages. All public symbols are re-exported here;
 * implementations live in `./agents`, `./cli`, `./lifecycle`, `./tools`, and
 * `./tui`.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { closeSurface } from "./tmux.ts";
import type { SubagentActivityState } from "./activity.ts";

import { publishRunningChildrenCount } from "./registry.ts";

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

export type {
  SubagentLaunchDetails,
  SubagentsListDetails,
  SubagentMessageDetails,
} from "./tools/subagent-tools.ts";

export type { SubagentResultDetails } from "./tui/message-renderers.ts";

export { SubagentParams } from "./tools/subagent-tools.ts";

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

// ── Runtime state ──

/**
 * Live record of one spawned subagent pane. The `index.ts` map keyed by `id`
 * is the single source of truth for steering, resuming, and shutdown.
 */
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

let latestCtx: ExtensionContext | null = null;
let latestPi: ExtensionAPI | null = null;

publishRunningChildrenCount(() => runningSubagents.size);

export { computeUniqueName } from "./tools/subagent-tools.ts";

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
import { renderSubagentWidgetLines } from "./tui/widgets.ts";
import { registerSubagentMessageRenderers } from "./tui/message-renderers.ts";

// ── Widget ──

/**
 * Mirrors the running map into the editor widget. Clears the widget when
 * nothing runs, and stays silent without UI so headless sessions never crash.
 */
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

// ── Watcher Completion Dispatcher (re-exported; implementation lives in ./lifecycle/dispatcher.ts) ──
export {
  attachSubagentWatcher,
  startStatusSupervision,
  startWidgetRefreshLater,
  stopDispatcherTimers,
  type SupervisionDeps,
  type AttachDeps,
  type AttachOptions,
} from "./lifecycle/dispatcher.ts";
import { stopDispatcherTimers } from "./lifecycle/dispatcher.ts";

// ── Launch (re-exported; implementation lives in ./lifecycle/launch.ts) ──
export {
  launchSubagent,
  type LaunchContext,
  type LaunchParams,
} from "./lifecycle/launch.ts";

// ── Watch (re-exported; implementation lives in ./lifecycle/watch.ts) ──
export {
  watchSubagent,
  getWatchTimeoutMs,
  type WatchedSubagent,
  type WatchDeps,
  type SubagentQuestionDetails,
} from "./lifecycle/watch.ts";

// ── Steer (re-exported; implementation lives in ./lifecycle/steer.ts) ──
export {
  findSubagentByName,
  steerSubagent,
  handleSubagentSteer,
  type SteerDeps,
} from "./lifecycle/steer.ts";

// ── Resume (re-exported; implementation lives in ./lifecycle/resume.ts) ──
export { resumeSubagent } from "./lifecycle/resume.ts";
import {
  registerSubagentTool,
  registerSubagentsListTool,
  registerSubagentMessageTool,
  registerSubagentCommand,
} from "./tools/subagent-tools.ts";

// ── Extension ──

/**
 * Registers the `subagent` tool family, the `/subagent` command, and the
 * result/question renderers. Disposes panes, timers, and watchers on
 * `session_shutdown` so no tmux surface outlives its parent session.
 *
 * @param pi Extension host for tools, commands, events, and messages.
 */
export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    stopDispatcherTimers();
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

  const toolDeps = {
    runningSubagents,
    updateWidget,
    getPi: () => latestPi,
  };
  registerSubagentTool(pi, toolDeps);
  registerSubagentsListTool(pi);
  registerSubagentMessageTool(pi, toolDeps);
  registerSubagentCommand(pi);

  registerSubagentMessageRenderers(pi);
}
