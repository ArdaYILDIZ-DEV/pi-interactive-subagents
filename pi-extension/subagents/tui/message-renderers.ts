/**
 * Renderers for steered subagent messages: `subagent_question` shows an
 * orchestrator-directed question box, `subagent_result` a success/failure
 * summary box. Registration is the module's only side effect; call once
 * per extension setup.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { formatElapsed } from "./widgets.ts";
import type { SessionStats } from "../session.ts";
import type { SubagentQuestionDetails } from "../lifecycle/watch.ts";

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

/**
 * Registers both renderers on the extension host.
 *
 * @param pi Extension host for message-renderer registration.
 */
export function registerSubagentMessageRenderers(pi: ExtensionAPI): void {
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
        // Strips the duplicated follow-up footer the dispatcher appends,
        // so the box shows the summary once.
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
