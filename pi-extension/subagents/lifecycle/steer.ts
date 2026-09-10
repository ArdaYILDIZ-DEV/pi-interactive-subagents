/**
 * Subagent steering: delivers orchestrator messages into a running pane.
 *
 * Steering never waits for a result; delivery is asynchronous and the
 * child observes the message on a later turn. Resuming a finished session is not steering, see
 * `./resume.ts`. `runningSubagents` stays owned by `index.ts` and arrives
 * via `SteerDeps`.
 */
import { sendCommand } from "../tmux.ts";
import type { RunningSubagent } from "../index.ts";

/**
 * Finds one running subagent by display name: exact match first, then a
 * case-insensitive fallback. Name collisions across sessions surface as an
 * ambiguity error carrying each candidate id.
 *
 * @param items Running subagents to search.
 * @param requestedName Display name as passed to `subagent_message`.
 * @returns The single match, or a human-readable error.
 */
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

/**
 * Sends a message to one running pane. Newlines are flattened because tmux
 * `send-keys -l` delivers the payload as a single pasted line.
 *
 * @param running Target subagent pane.
 * @param message Raw message text.
 * @returns Success marker, or a delivery error naming the subagent.
 */
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

export interface SteerDeps {
  runningSubagents: Map<string, RunningSubagent>;
  updateWidget: () => void;
}

/**
 * Implements the steer half of `subagent_message`: validates the message,
 * resolves the name against the running map, and delivers it.
 *
 * @param params Tool-style `{ name, message }` payload.
 * @param deps Running map plus widget refresh callback.
 * @returns Tool result content with a `steered` status or an error detail.
 */
export function handleSubagentSteer(
  params: { name?: string; message?: string },
  deps: SteerDeps,
): {
  content: Array<{ type: "text"; text: string }>;
  details: { error?: string; id?: string; name?: string; status?: string };
} {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err },
    };
  }
  const result = findSubagentByName(
    Array.from(deps.runningSubagents.values()),
    params.name ?? "",
  );
  if ("error" in result) {
    return {
      content: [{ type: "text" as const, text: result.error }],
      details: { error: result.error },
    };
  }
  const running = result.found;
  const steer = steerSubagent(running, message);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }
  deps.updateWidget();
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
