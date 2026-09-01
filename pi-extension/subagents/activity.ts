/**
 * Activity recorder for publishing subagent execution state to the parent session.
 *
 * Emits throttled state writes to an activity file consumed by the parent status supervisor.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type ActivityPhase = "starting" | "active" | "waiting" | "done";

export interface SubagentActivityState {
  version: 1;
  runningChildId: string;
  updatedAt: number;
  phase: ActivityPhase;
  latestEvent: string;
}

export type ActivityReadResult =
  | { ok: true; activity: SubagentActivityState }
  | { ok: false; phase: "missing" };

export interface SubagentActivityRecorder {
  sessionStart(): void;
  agentStart(): void;
  agentEndWaiting(): void;
  agentEndDone(): void;
  toolStart(): void;
  toolEnd(): void;
  askQuestion(): void;
  waiting(): void;
}

/** Minimum ms between successive disk writes; prevents thrashing during rapid tool loops. */
const FLUSH_THROTTLE_MS = 300;
/** Disable writes permanently after this many consecutive I/O failures. */
const MAX_WRITE_FAILURES = 3;

export function getSubagentActivityFile(artifactDir: string, runningChildId: string): string {
  return join(artifactDir, "subagent-activity", `${runningChildId}.json`);
}

export function readSubagentActivityFile(
  activityFile: string,
  expectedRunningChildId: string,
): ActivityReadResult {
  if (!existsSync(activityFile)) return { ok: false, phase: "missing" };
  try {
    const parsed = JSON.parse(readFileSync(activityFile, "utf8")) as SubagentActivityState;
    if (parsed.version !== 1 || typeof parsed.updatedAt !== "number") {
      return { ok: false, phase: "missing" };
    }
    if (parsed.runningChildId !== expectedRunningChildId) {
      return { ok: false, phase: "missing" };
    }
    return { ok: true, activity: parsed };
  } catch {
    return { ok: false, phase: "missing" };
  }
}

/** Returns a no-op recorder used when required env vars are absent (e.g. in the parent session). */
function noopRecorder(): SubagentActivityRecorder {
  return {
    sessionStart() {},
    agentStart() {},
    agentEndWaiting() {},
    agentEndDone() {},
    toolStart() {},
    toolEnd() {},
    askQuestion() {},
    waiting() {},
  };
}

export function createSubagentActivityRecorder(params: {
  runningChildId?: string;
  activityFile?: string;
  now?: () => number;
}): SubagentActivityRecorder {
  const runningChildId = params.runningChildId?.trim();
  const activityFile = params.activityFile?.trim();
  if (!runningChildId || !activityFile) return noopRecorder();

  const activeChildId = runningChildId;
  const activeActivityFile = activityFile;

  const now = params.now ?? (() => Date.now());
  const state: SubagentActivityState = {
    version: 1,
    runningChildId: activeChildId,
    updatedAt: now(),
    phase: "starting",
    latestEvent: "session_start",
  };

  let disabled = false;
  let failures = 0;
  let lastFlush = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;

  function clearPending() {
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
  }

  function flushNow() {
    if (disabled) return;
    try {
      mkdirSync(dirname(activeActivityFile), { recursive: true });
      writeFileSync(activeActivityFile, JSON.stringify(state), "utf8");
      lastFlush = now();
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= MAX_WRITE_FAILURES) disabled = true;
    }
  }

  function scheduleFlush() {
    if (disabled || pending) return;
    const remaining = Math.max(0, FLUSH_THROTTLE_MS - (now() - lastFlush));
    if (remaining === 0) {
      flushNow();
      return;
    }
    pending = setTimeout(() => {
      pending = null;
      flushNow();
    }, remaining);
  }

  function record(phase: ActivityPhase, event: string, flush: "immediate" | "throttled") {
    if (disabled) return;
    if (flush === "immediate") clearPending();
    state.updatedAt = now();
    state.phase = phase;
    state.latestEvent = event;
    if (flush === "immediate") flushNow();
    else scheduleFlush();
  }

  return {
    sessionStart() {
      record("starting", "session_start", "immediate");
    },
    agentStart() {
      record("active", "agent_start", "immediate");
    },
    agentEndWaiting() {
      record("waiting", "agent_end", "immediate");
    },
    agentEndDone() {
      record("done", "agent_end", "immediate");
      disabled = true;
    },
    toolStart() {
      record("active", "tool_execution_start", "throttled");
    },
    toolEnd() {
      record("active", "tool_execution_end", "throttled");
    },
    askQuestion() {
      record("waiting", "ask_question", "immediate");
    },
    waiting() {
      record("waiting", "waiting", "immediate");
    },
  };
}
