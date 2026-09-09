/**
 * Subagent watcher (extracted from `index.ts` — pure move, no behavior change).
 *
 * Polls completion sidecars / terminal sentinel / pane liveness until the
 * subagent exits. Global state (`runningSubagents`, `latestPi`) is not moved:
 * callers inject the two hooks they need via {@link WatchDeps}.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { pollForExit, closeSurface, type AskSidecarPayload } from "../tmux.ts";
import {
  getSessionId,
  getNewEntries,
  findLastAssistantMessage,
  summarizeSessionStats,
  type SessionEntry,
} from "../session.ts";
import {
  readSubagentActivityFile,
  type SubagentActivityState,
} from "../activity.ts";
import { parseEnvInt } from "../env.ts";
import type { SubagentResult } from "../tui/widgets.ts";

export interface SubagentQuestionDetails {
  name?: string;
  question?: string;
}

/** Minimal subset of `RunningSubagent` read by the watcher (satisfied by it). */
export interface WatchedSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  activityFile?: string;
  activity?: SubagentActivityState;
}

/** State hooks injected by the extension entry point (avoids moving globals). */
export interface WatchDeps {
  getPi: () => ExtensionAPI | null;
  removeRunning: (id: string) => void;
}

/**
 * Watcher poll timeout in milliseconds (0 = disabled).
 * Prevents indefinite polling when a pane exits unexpectedly.
 */
export function getWatchTimeoutMs(): number {
  return parseEnvInt(process.env.PI_SUBAGENT_WATCH_TIMEOUT_MS, 0, 1);
}

function checkAskSidecar(
  sessionFile: string,
  subagentName: string,
  pi: ExtensionAPI | null,
): void {
  if (!sessionFile || !pi) return;
  try {
    const askFile = `${sessionFile}.ask`;
    if (!existsSync(askFile)) return;

    const askData = JSON.parse(
      readFileSync(askFile, "utf8"),
    ) as AskSidecarPayload;
    rmSync(askFile, { force: true });
    if (!askData || typeof askData.question !== "string") return;

    const questionDetails: SubagentQuestionDetails = {
      name: subagentName,
      question: askData.question,
    };
    pi.sendMessage(
      {
        customType: "subagent_question",
        content:
          `Sub-agent "${subagentName}" is asking a question:\n\n` +
          `> ${askData.question}\n\n` +
          `Reply using: subagent_message({ name: "${subagentName}", message: "..." })`,
        display: true,
        details: questionDetails,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch {
    // The .ask sidecar may be consumed or deleted concurrently; ignore races.
  }
}

export async function watchSubagent(
  running: WatchedSubagent,
  signal: AbortSignal,
  deps: WatchDeps,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile, agent } = running;
  try {
    const result = await pollForExit(surface, signal, {
      interval: 1000,
      sessionFile,
      ...(getWatchTimeoutMs() ? { timeoutMs: getWatchTimeoutMs() } : {}),
      onTick() {
        checkAskSidecar(sessionFile, running.name, deps.getPi());
        if (!running.activityFile) return;
        const read = readSubagentActivityFile(running.activityFile, running.id);
        if (read.ok) running.activity = read.activity;
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const hasSession = existsSync(sessionFile);
    let summary: string;
    let allEntries: SessionEntry[] | null = null;

    if (hasSession) {
      allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode === 0
            ? "Sub-agent exited without output"
            : `Sub-agent exited with code ${result.exitCode}`);
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode === 0
          ? "Sub-agent exited without output"
          : `Sub-agent exited with code ${result.exitCode}`;
    }

    const stats = allEntries
      ? summarizeSessionStats(allEntries)
      : hasSession
        ? summarizeSessionStats(sessionFile)
        : null;
    const subagentSessionId = hasSession
      ? allEntries?.[0]?.type === "session" &&
        typeof allEntries[0]?.id === "string"
        ? (allEntries[0].id as string)
        : getSessionId(sessionFile)
      : null;

    try {
      closeSurface(surface);
    } catch {
      // Pane may already be gone if the process exited on its own.
    }
    deps.removeRunning(running.id);

    return {
      name,
      task,
      agent,
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: unknown) {
    try {
      closeSurface(surface);
    } catch {
      // Pane may already be gone if the process exited on its own.
    }
    deps.removeRunning(running.id);

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const msg = err instanceof Error ? err.message : String(err);
    if (signal.aborted) {
      return {
        name,
        task,
        agent,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed,
        errorMessage: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      agent,
      summary: `Subagent error: ${msg}`,
      exitCode: 1,
      elapsed,
      errorMessage: msg,
    };
  }
}
