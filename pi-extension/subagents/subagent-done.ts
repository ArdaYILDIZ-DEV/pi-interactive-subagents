/**
 * Child-side extension, loaded inside each subagent process.
 *
 * Reports liveness through the activity recorder, relays orchestrator
 * questions via `ask_question`, and auto-exits when the task completes.
 * Completion is signaled to the parent with sidecar files next to the
 * session file: `.done` on success, `.exit` on error, `.ask` per question.
 * Auto-exit is refused while child subagents are still running.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSubagentActivityRecorder } from "./activity.ts";
import { runningChildrenCount } from "./registry.ts";
import { parseEnvInt } from "./env.ts";
import { assertPiExtensionApi } from "./pi-compat.ts";
import type {
  AskSidecarPayload,
  DoneSidecarPayload,
  ExitSidecarPayload,
} from "./tmux.ts";

export interface AssistantMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Returns the count of active child subagents spawned by this session. */
export { runningChildrenCount } from "./registry.ts";

function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function writeSidecar(path: string, payload: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error: unknown) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write error if temporary-file cleanup also fails.
    }
    throw error;
  }
}

function writeExitSidecar(
  sessionFile: string,
  errorInfo: { errorMessage: string } | null,
): void {
  if (errorInfo) {
    const exitPayload: ExitSidecarPayload = {
      type: "error", errorMessage: errorInfo.errorMessage, stopReason: "error",
    };
    writeSidecar(`${sessionFile}.exit`, exitPayload);
  } else {
    const donePayload: DoneSidecarPayload = { type: "done", timestamp: Date.now() };
    writeSidecar(`${sessionFile}.done`, donePayload);
  }
}

/**
 * Child-process entry point. All hooks below only observe and report; the
 * orchestrator-side supervision lives in the parent extension.
 *
 * @param pi Child session extension host.
 */
export default function (pi: ExtensionAPI) {
  try {
    assertPiExtensionApi(pi, "child");
  } catch (error: unknown) {
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Subagent startup failed: ${detail}\n`);
    try {
      writeExitSidecar(sessionFile, { errorMessage: detail });
    } catch (writeError: unknown) {
      process.stderr.write(`Subagent startup error sidecar failed: ${String(writeError)}\n`);
    }
    process.exit(1);
    return;
  }
  if (typeof pi.registerShortcut !== "function" || typeof pi.getAllTools !== "function") {
    process.stderr.write("Subagent UI helpers are unavailable; tools and completion supervision remain enabled.\n");
  }
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;
  let widgetWarningShown = false;

  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (typeof ctx.ui?.setWidget !== "function") {
      if (!widgetWarningShown) process.stderr.write("Subagent tools widget unavailable: missing ui.setWidget().\n");
      widgetWarningShown = true;
      return;
    }
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: TUI, theme: Theme) => {
        const box = new Box(1, 0, (text: string) =>
          theme.bg("toolSuccessBg", text),
        );
        const label = subagentAgent || subagentName;
        const agentTag = label
          ? theme.bold(theme.fg("accent", `[${label}]`))
          : "";
        if (expanded) {
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");
          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));
          const deniedLine =
            denied.length > 0
              ? "\n" +
                theme.fg("muted", "denied: ") +
                denied
                  .map((n: string) => theme.fg("error", n))
                  .join(theme.fg("muted", ", "))
              : "";
          box.addChild(
            new Text(
              `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
              0,
              0,
            ),
          );
        } else {
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") +
                theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");
          box.addChild(
            new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0),
          );
        }
        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let awaitingAnswer = false;
  let isExiting = false;
  let lastSeenMessages: readonly AssistantMessageLike[] | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSafetyTimers(): void {
    if (settleTimer) clearTimeout(settleTimer);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    settleTimer = null;
    shutdownTimer = null;
  }

  function failAndExit(message: string, ctx: ExtensionContext): void {
    isExiting = true;
    clearSafetyTimers();
    stopHeartbeat();
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (sessionFile) {
      try {
        rmSync(`${sessionFile}.done`, { force: true });
      } catch {
        // The stderr diagnostic and nonzero exit remain available if cleanup fails.
      }
      try {
        writeExitSidecar(sessionFile, { errorMessage: message });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        message += ` Error sidecar could not be written: ${detail}`;
      }
    }
    process.stderr.write(`Subagent lifecycle error: ${message}\n`);
    try {
      ctx.shutdown();
    } catch {
      // The bounded safety exit below does not depend on the host shutdown API.
    }
    process.exit(1);
  }

  function canAutoExit(messages: readonly AssistantMessageLike[] | undefined): boolean {
    return !awaitingAnswer && runningChildrenCount() === 0 &&
      shouldAutoExit() && shouldAutoExitOnAgentEnd(messages);
  }

  function awaitSettlement(ctx: ExtensionContext): void {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    if (isExiting || !canAutoExit(lastSeenMessages)) return;
    const timeoutMs = parseEnvInt(process.env.PI_SUBAGENT_SETTLE_TIMEOUT_MS, 30_000, 1);
    settleTimer = setTimeout(() => {
      failAndExit(`Pi did not emit agent_settled within ${timeoutMs}ms after agent_end.`, ctx);
    }, timeoutMs);
  }

  function getHeartbeatIntervalMs(): number {
    return parseEnvInt(process.env.PI_SUBAGENT_HEARTBEAT_MS, 15_000, 1);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      recorder.heartbeat();
    }, getHeartbeatIntervalMs());
    heartbeatTimer.unref?.();
  }

  function shouldAutoExit(): boolean {
    const envVal = process.env.PI_SUBAGENT_AUTO_EXIT;
    if (envVal === "0" || envVal === "false") return false;
    if (envVal === "1" || envVal === "true") return true;
    return Boolean(process.env.PI_SUBAGENT_SESSION);
  }

  /**
   * Decides whether this turn ends the process. Skips exit while an
   * orchestrator answer is pending or children still run, so neither a
   * question nor a subtree is orphaned by an early shutdown.
   */
  function handleExit(
    messages: readonly AssistantMessageLike[] | undefined,
    ctx: ExtensionContext,
  ) {
    if (isExiting) return;

    if (!canAutoExit(messages)) {
      recorder.agentEndWaiting();
      return;
    }

    isExiting = true;
    const errorInfo = findLatestAssistantError(messages);
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (sessionFile) {
      try {
        writeExitSidecar(sessionFile, errorInfo);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        failAndExit(`Could not write completion sidecar: ${detail}`, ctx);
        return;
      }
    }
    recorder.agentEndDone();
    stopHeartbeat();
    const timeoutMs = parseEnvInt(process.env.PI_SUBAGENT_SHUTDOWN_TIMEOUT_MS, 10_000, 1);
    shutdownTimer = setTimeout(() => {
      failAndExit(`Pi shutdown did not complete within ${timeoutMs}ms after agent_settled.`, ctx);
    }, timeoutMs);
    try {
      ctx.shutdown();
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      failAndExit(`Pi shutdown failed after agent_settled: ${detail}`, ctx);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    startHeartbeat();
    try {
      const tools: unknown = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
      if (!Array.isArray(tools) || tools.some((tool) => !tool || typeof tool.name !== "string")) {
        throw new Error("Pi getAllTools returned an invalid tool list");
      }
      toolNames = tools.map((tool) => tool.name).sort();
    } catch (error: unknown) {
      toolNames = [];
      process.stderr.write(`Subagent tool listing disabled: ${String(error)}\n`);
    }
    denied = parseDeniedTools(process.env.PI_DENY_TOOLS);
    renderWidget(ctx);
  });

  pi.on("input", () => {
    recorder.waiting();
    awaitingAnswer = false;
  });

  pi.on("agent_start", () => {
    clearSafetyTimers();
    lastSeenMessages = undefined;
    awaitingAnswer = false;
    recorder.agentStart();
    startHeartbeat();
  });

  pi.on("tool_execution_start", () => {
    recorder.toolStart();
  });

  pi.on("tool_execution_update", () => {
    recorder.toolStart();
  });

  pi.on("tool_execution_end", () => {
    recorder.toolEnd();
  });

  pi.on("message_update", () => {
    recorder.heartbeat();
  });

  pi.on("turn_start", () => {
    clearSafetyTimers();
    recorder.turnStart();
  });

  pi.on("session_shutdown", () => {
    isExiting = true;
    clearSafetyTimers();
    stopHeartbeat();
  });

  pi.on("agent_end", (event, ctx) => {
    lastSeenMessages = Array.isArray(event.messages) ? event.messages : undefined;
    recorder.agentEndWaiting();
    awaitSettlement(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    handleExit(lastSeenMessages, ctx);
  });

  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut("ctrl+alt+o", {
      description: "Toggle subagent tools widget",
      handler: (ctx) => {
        expanded = !expanded;
        renderWidget(ctx);
      },
    });
  }

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator a single question and pause until they reply. Your session stays open; the answer " +
      "arrives as your next message. Ask exactly one question per call.",
    parameters: Type.Object({
      question: Type.String({
        description: "The single freeform question to ask the orchestrator.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts (PI_SUBAGENT_SESSION not set).",
        );
      }
      const askData: AskSidecarPayload = {
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
      };
      try {
        writeSidecar(`${sessionFile}.ask`, askData);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to send subagent question: ${detail}`);
      }
      awaitingAnswer = true;
      recorder.askQuestion();
      return {
        content: [
          {
            type: "text" as const,
            text: "Question sent to the orchestrator. Stop here and wait — their reply will arrive as your next message.",
          },
        ],
        details: { question: params.question },
      };
    },
  });
}

/**
 * Determines whether the subagent should automatically terminate after the latest turn.
 * Turns aborted by user intervention remain open; completed turns exit.
 */
function shouldAutoExitOnAgentEnd(
  messages: readonly (AssistantMessageLike | unknown)[] | undefined,
): boolean {
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        typeof msg === "object" &&
        msg !== null &&
        "role" in msg &&
        (msg as AssistantMessageLike).role === "assistant"
      ) {
        return (msg as AssistantMessageLike).stopReason !== "aborted";
      }
    }
  }
  return true;
}

/**
 * Extracts error details from the final assistant message when an unrecoverable failure occurs.
 */
function findLatestAssistantError(
  messages: readonly (AssistantMessageLike | unknown)[] | undefined,
): { errorMessage: string } | null {
  if (!messages) return { errorMessage: "Pi agent_end messages payload is missing or invalid." };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null || !("role" in msg)) continue;
    const asAssistant = msg as AssistantMessageLike;
    if (asAssistant.role !== "assistant") continue;
    if (asAssistant.stopReason !== "error") {
      if (["stop", "length", "toolUse"].includes(asAssistant.stopReason ?? "")) return null;
      return { errorMessage: `Pi final assistant stopReason is missing or unsupported: ${String(asAssistant.stopReason)}.` };
    }
    const raw =
      typeof asAssistant.errorMessage === "string"
        ? asAssistant.errorMessage.trim()
        : "";
    return {
      errorMessage:
        raw ||
        "Subagent agent loop ended with stopReason=error (no errorMessage field).",
    };
  }
  return { errorMessage: "Pi agent_end messages contain no final assistant message." };
}
