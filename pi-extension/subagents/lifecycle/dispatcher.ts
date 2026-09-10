/**
 * Watcher completion dispatcher: turns a finished subagent pane into an
 * orchestrator message, and keeps the status widget fresh while panes run.
 *
 * Both refresh timers tick every 2s and stop themselves once the running
 * map drains; `stopDispatcherTimers` is the `session_shutdown` backstop.
 * `checkAskSidecar` stays in `./watch.ts` where the poll loop consumes it.
 * Global state stays in `index.ts`; callers inject it via deps.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSubagentActivityFile } from "../activity.ts";
import {
  resolveResultPresentation,
  statusConfig,
} from "../tui/widgets.ts";
import { watchSubagent } from "./watch.ts";
import type { RunningSubagent } from "../index.ts";

export interface SupervisionDeps {
  runningSubagents: Map<string, RunningSubagent>;
  updateWidget: () => void;
}

export interface AttachDeps extends SupervisionDeps {
  getPi: () => ExtensionAPI | null;
}

export interface AttachOptions {
  sessionId?: string | null;
  isResume?: boolean;
  onCompleted?: () => void;
}

let statusTimer: ReturnType<typeof setInterval> | null = null;
let widgetTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the 2s activity poll that feeds the status widget. Guarded by
 * `statusConfig.enabled`; safe to call per spawn because a running timer
 * is reused instead of duplicated.
 *
 * @param deps Running map plus widget refresh callback.
 */
export function startStatusSupervision(deps: SupervisionDeps): void {
  if (!statusConfig.enabled || statusTimer) return;
  statusTimer = setInterval(() => {
    if (deps.runningSubagents.size === 0) {
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      return;
    }
    for (const running of deps.runningSubagents.values()) {
      if (!running.activityFile) continue;
      const read = readSubagentActivityFile(running.activityFile, running.id);
      if (read.ok) running.activity = read.activity;
    }
    deps.updateWidget();
  }, 2000);
}

/**
 * Paints once immediately, then refreshes every 2s until no subagent
 * remains. Safe to call per spawn; an existing timer is reused.
 *
 * @param deps Running map plus widget refresh callback.
 */
export function startWidgetRefreshLater(deps: SupervisionDeps): void {
  if (widgetTimer) return;
  deps.updateWidget();
  widgetTimer = setInterval(() => {
    if (deps.runningSubagents.size === 0) {
      if (widgetTimer) clearInterval(widgetTimer);
      widgetTimer = null;
      return;
    }
    deps.updateWidget();
  }, 2000);
}

/**
 * Clears both refresh timers. Called on `session_shutdown`; the timers
 * also self-clear when idle, so this is strictly a backstop.
 */
export function stopDispatcherTimers(): void {
  if (widgetTimer) {
    clearInterval(widgetTimer);
    widgetTimer = null;
  }
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

/**
 * Watches one pane to completion and steers the outcome back as a
 * `subagent_result` message. Resume completions get rewritten summaries
 * so the orchestrator can tell a resumed exit from a fresh one.
 *
 * @param running Tracked pane to watch.
 * @param pi Extension host used to deliver the result message.
 * @param deps Running map, widget refresh, and live parent handle.
 * @param options Optional session override, resume mode, and completion hook.
 */
export function attachSubagentWatcher(
  running: RunningSubagent,
  pi: ExtensionAPI,
  deps: AttachDeps,
  options?: AttachOptions,
): void {
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;

  watchSubagent(running, watcherAbort.signal, {
    getPi: deps.getPi,
    removeRunning: (id) => {
      deps.runningSubagents.delete(id);
    },
  })
    .then((result) => {
      options?.onCompleted?.();
      deps.updateWidget();
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
      deps.updateWidget();
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
