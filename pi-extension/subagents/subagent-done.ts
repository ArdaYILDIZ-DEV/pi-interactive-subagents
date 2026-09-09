/**
 * Extension loaded into child subagent processes.
 *
 * Manages tool status display, orchestrator communication (`ask_question`),
 * and automated exit handling upon task completion or error.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import { runningChildrenCount } from "./registry.ts";
import { parseEnvInt } from "./env.ts";
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

function writeExitSidecar(
  sessionFile: string,
  errorInfo: { errorMessage: string } | null,
): void {
  try {
    if (errorInfo) {
      const exitPayload: ExitSidecarPayload = {
        type: "error",
        errorMessage: errorInfo.errorMessage,
        stopReason: "error",
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitPayload));
    } else {
      const donePayload: DoneSidecarPayload = {
        type: "done",
        timestamp: Date.now(),
      };
      writeFileSync(`${sessionFile}.done`, JSON.stringify(donePayload));
    }
  } catch {
    // Session directory may be unreachable if the process is being torn down.
  }
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: Pick<ExtensionContext, "ui">) {
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

  let agentStarted = false;
  let awaitingAnswer = false;
  let isExiting = false;
  let lastSeenMessages: readonly AssistantMessageLike[] | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
    return !!process.env.PI_SUBAGENT_SESSION;
  }

  function handleExit(
    messages: readonly AssistantMessageLike[] | undefined,
    ctx: ExtensionContext,
  ) {
    if (isExiting || awaitingAnswer) return;

    if (
      runningChildrenCount() > 0 ||
      !shouldAutoExit() ||
      !shouldAutoExitOnAgentEnd(messages)
    ) {
      recorder.agentEndWaiting();
      return;
    }

    isExiting = true;
    const errorInfo = findLatestAssistantError(messages);
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (sessionFile) {
      writeExitSidecar(sessionFile, errorInfo);
    }
    recorder.agentEndDone();
    stopHeartbeat();
    try {
      ctx.shutdown();
    } catch {}
    // ctx.shutdown() may return before the process has fully wound down;
    // the timer guarantees the shell prompt returns in the tmux pane.
    setTimeout(() => {
      try {
        process.exit(0);
      } catch {}
    }, 100);
  }

  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    startHeartbeat();
    toolNames = pi
      .getAllTools()
      .map((t) => t.name)
      .sort();
    denied = parseDeniedTools(process.env.PI_DENY_TOOLS);
    renderWidget(ctx);
  });

  pi.on("input", () => {
    recorder.waiting();
    awaitingAnswer = false;
  });

  pi.on("agent_start", () => {
    agentStarted = true;
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
    recorder.turnStart();
  });

  pi.on("session_shutdown", () => {
    stopHeartbeat();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = event.messages as unknown as
      | readonly AssistantMessageLike[]
      | undefined;
    lastSeenMessages = messages;
    handleExit(messages, ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (lastSeenMessages) {
      handleExit(lastSeenMessages, ctx);
    }
  });

  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx);
    },
  });

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
      awaitingAnswer = true;
      recorder.askQuestion();
      const askData: AskSidecarPayload = {
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
      };
      try {
        writeFileSync(`${sessionFile}.ask`, JSON.stringify(askData));
      } catch {
        // Ignore errors if the orchestrator directory is unreachable.
      }
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
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null || !("role" in msg)) continue;
    const asAssistant = msg as AssistantMessageLike;
    if (asAssistant.role !== "assistant") continue;
    if (asAssistant.stopReason !== "error") return null;
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
  return null;
}
