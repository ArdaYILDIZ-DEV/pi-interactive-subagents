/**
 * TUI widget render helpers (extracted from `index.ts` — pure move, no behavior change).
 *
 * All functions here are pure string renderers; stateful supervision
 * (`updateWidget`, `startStatusSupervision`) stays in `index.ts`.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  loadStatusConfig,
  classifyActivity,
  type StatusConfig,
} from "../status.ts";
import type { SubagentActivityState } from "../activity.ts";
import type { SessionStats } from "../session.ts";

const statusConfig: StatusConfig = loadStatusConfig();
export { statusConfig };

/** Minimal row read by the widget renderer (satisfied by `RunningSubagent`). */
export interface WidgetAgentRow {
  name: string;
  agent?: string;
  startTime: number;
  activity?: SubagentActivityState | null;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

export function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;
  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }
  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

export function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;
  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const content = `${titlePart}${"─".repeat(fillLen)}${infoPart}`
    .slice(0, inner)
    .padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

export function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;
  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

export function statusLabelFor(
  activity: SubagentActivityState | null,
  startTime: number,
  now: number,
  stallAfterMs: number = statusConfig.stallAfterMs,
): string {
  const view = activity
    ? { ok: true, phase: activity.phase, updatedAt: activity.updatedAt }
    : { ok: false, phase: "missing" as const, updatedAt: startTime };
  const { kind } = classifyActivity(view, now, stallAfterMs);
  return kind;
}

export function renderSubagentWidgetLines(
  agents: WidgetAgentRow[],
  width: number,
): string[] {
  const lines: string[] = [
    borderTop("Subagents", `${agents.length} running`, width),
  ];
  const now = Date.now();
  for (const agent of agents) {
    const elapsed = formatElapsed(Math.floor((now - agent.startTime) / 1000));
    const kind = statusLabelFor(
      agent.activity ?? null,
      agent.startTime,
      now,
      statusConfig.stallAfterMs,
    );
    const left = ` ${elapsed}  ${agent.name}${agent.agent ? ` (${agent.agent})` : ""} `;
    const right = statusConfig.enabled ? ` ${kind} ` : " running… ";
    lines.push(borderLine(left, right, width));
  }
  lines.push(borderBottom(width));
  return lines;
}

export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  sessionId?: string | null;
  agent?: string;
  exitCode: number;
  elapsed: number;
  errorMessage?: string;
  stats?: SessionStats | null;
}

export function resolveResultPresentation(result: SubagentResult): string {
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${result.name}", message: "…" })`;
  if (result.errorMessage) {
    return (
      `Sub-agent "${result.name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\nError: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. Retry by spawning a new subagent or resume it ` +
      `with subagent_message.${sessionRef}`
    );
  }
  return result.exitCode === 0
    ? `Sub-agent "${result.name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${result.name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`;
}
