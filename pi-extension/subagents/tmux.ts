/**
 * tmux pane management and terminal interaction layer.
 *
 * All pane interaction is routed through this module to isolate multiplexer
 * dependencies and keep other extension layers testable.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command))
    return commandAvailability.get(command)!;
  let available = false;
  try {
    // Pass command as $1 argument to avoid shell metacharacter injection.
    execFileSync("sh", ["-c", 'command -v "$1"', "sh", command], {
      stdio: "ignore",
    });
    available = true;
  } catch {
    available = false;
  }
  commandAvailability.set(command, available);
  return available;
}

/** Test-only reset so command-availability results never leak between test cases. */
export function clearCommandAvailabilityCache(): void {
  commandAvailability.clear();
}

/** Returns true when the TMUX environment variable is set and the tmux binary is on PATH. */
export function isMuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

/**
 * Escapes a string for safe single-quoted shell embedding.
 * Strips null bytes to prevent truncation attacks.
 */
export function shellEscape(s: string): string {
  const sanitized = typeof s === "string" ? s.replace(/\0/g, "") : "";
  return "'" + sanitized.replace(/'/g, "'\\''") + "'";
}

const SUBAGENT_TMUX_LAYOUT = "even-horizontal";
let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced rebalance of the even-horizontal layout.
 * Called after every split or close so panes share width evenly.
 */
function rebalanceSurfaces(hintPane?: string): void {
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      execFileSync(
        "tmux",
        ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT],
        {
          encoding: "utf8",
        },
      );
    } catch {
      // Pane may have closed between the timer firing and the command executing.
    }
  }, 120);
}

function requireTmux(): void {
  if (!isMuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

/** Creates a right-split pane off the parent pi pane, sets its title, and returns the new pane identifier. */
export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  requireTmux();
  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") args.push("-h");
  else args.push("-v");
  if (direction === "left" || direction === "up") args.push("-b");
  if (fromSurface) args.push("-t", fromSurface);
  args.push("-P", "-F", "#{pane_id}");
  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%"))
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  // Set a descriptive title so the pane is identifiable in the terminal.
  try {
    execFileSync("tmux", ["select-pane", "-t", pane, "-T", name], {
      encoding: "utf8",
    });
  } catch {
    // Non-fatal: title setting may fail in environments that restrict pane rename.
  }
  rebalanceSurfaces(pane);
  return pane;
}

/** Sends raw keystrokes to a pane and executes them with Enter. */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], {
    encoding: "utf8",
  });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], {
    encoding: "utf8",
  });
}

/**
 * Executes a command via a generated script file to avoid terminal line-wrapping truncation.
 * Uses restrictive 0700 file and folder permissions to secure environment tokens.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptDir = join(tmpdir(), "pi-subagent-scripts");
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  const scriptPath =
    options?.scriptPath ??
    join(
      scriptDir,
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true, mode: 0o700 });
  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble)
    scriptParts.push(options.scriptPreamble.trimEnd());
  scriptParts.push(command);
  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o700 });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}; exit`);
  return scriptPath;
}

export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
}

export async function readScreenAsync(
  surface: string,
  lines = 50,
): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

export function isPaneAlive(surface: string): boolean {
  if (!isMuxAvailable()) return false;
  try {
    const panes = execFileSync(
      "tmux",
      ["list-panes", "-a", "-F", "#{pane_id}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return panes
      .split("\n")
      .map((p) => p.trim())
      .includes(surface);
  } catch {
    return false;
  }
}

export async function isPaneAliveAsync(surface: string): Promise<boolean> {
  if (!isMuxAvailable()) return false;
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["list-panes", "-a", "-F", "#{pane_id}"],
      {
        encoding: "utf8",
      },
    );
    return stdout
      .split("\n")
      .map((p) => p.trim())
      .includes(surface);
  } catch {
    return false;
  }
}

export function closeSurface(surface: string): void {
  requireTmux();
  // Skip kill-pane when the pane is already gone. That is the normal case
  // (the launch script ends with `exit`, so the shell closes the pane before
  // the watcher runs), and every kill-pane aimed at a dead pane makes the
  // tmux server flash "can't find pane: %N". list-panes targets no pane,
  // so this probe can never fail that way.
  if (!isPaneAlive(surface)) {
    rebalanceSurfaces();
    return;
  }
  try {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  } catch {
    // Pane raced us and closed between the liveness probe and kill-pane.
  }
  rebalanceSurfaces();
}

export interface DoneSidecarPayload {
  type: "done";
  timestamp: number;
}

export interface ExitSidecarPayload {
  type: "error";
  errorMessage: string;
  stopReason?: string;
}

export interface AskSidecarPayload {
  name: string;
  agent: string;
  question: string;
}

export type SubagentSidecarPayload =
  | DoneSidecarPayload
  | ExitSidecarPayload
  | AskSidecarPayload;

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

export function interpretExitSidecar(data: unknown): PollResult {
  if (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type: unknown }).type === "error"
  ) {
    const errorData = data as Partial<ExitSidecarPayload>;
    const errorMessage =
      typeof errorData.errorMessage === "string" &&
      errorData.errorMessage.trim() !== ""
        ? errorData.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __test__ = {
  interpretExitSidecar,
  hasCommand,
  clearCache: clearCommandAvailabilityCache,
};

function checkSessionSidecars(sessionFile: string): PollResult | null {
  try {
    const doneFile = `${sessionFile}.done`;
    if (existsSync(doneFile)) {
      rmSync(doneFile, { force: true });
      return { reason: "done", exitCode: 0 };
    }
    const exitFile = `${sessionFile}.exit`;
    if (existsSync(exitFile)) {
      const data: unknown = JSON.parse(readFileSync(exitFile, "utf8"));
      rmSync(exitFile, { force: true });
      return interpretExitSidecar(data);
    }
  } catch {
    // Ignore corrupted or partially written sidecar files.
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls until the subagent process exits, a completion sidecar appears, or the timeout expires.
 *
 * Non-blocking polling monitors completion sidecars, terminal sentinel output, and pane liveness.
 * Resolves with reason "error" on timeout to avoid hanging watchers.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    timeoutMs?: number;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Prefer completion sidecars (.done or .exit) written on agent loop termination.
    if (options.sessionFile) {
      const sidecarResult = checkSessionSidecars(options.sessionFile);
      if (sidecarResult) return sidecarResult;
    }

    // Probe liveness before touching the pane: capture-pane aimed at a dead
    // pane fails loudly on the tmux server ("can't find pane: %N") on every
    // cycle, while list-panes targets no pane and stays quiet.
    if (!(await isPaneAliveAsync(surface))) {
      return { reason: "done", exitCode: 0 };
    }

    // Fall back to terminal sentinel output if sidecar files are unavailable.
    try {
      const screen = await readScreenAsync(surface, 200);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch (err: unknown) {
      // tmux errors here mean the pane is gone; treat as a clean exit.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("can't find pane") ||
        msg.includes("no server running") ||
        !(await isPaneAliveAsync(surface))
      ) {
        return { reason: "done", exitCode: 0 };
      }
    }

    if (!(await isPaneAliveAsync(surface))) {
      return { reason: "done", exitCode: 0 };
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (options.timeoutMs && Date.now() - start >= options.timeoutMs) {
      return {
        reason: "error",
        exitCode: 1,
        errorMessage: `Subagent did not exit within ${Math.round(options.timeoutMs / 1000)}s`,
      };
    }

    options.onTick?.(elapsed);
    await sleep(options.interval, signal);
  }
}
