/**
 * Integration test harness for interactive-subagents.
 *
 * Provides utilities to create isolated test environments, start real pi
 * sessions in tmux panes, and poll for file/screen output. These tests drive
 * REAL pi sessions with REAL LLM calls and require tmux.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, readdirSync, rmSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  isMuxAvailable,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
} from "../../pi-extension/subagents/tmux.ts";

export { isMuxAvailable, createSurface, createSurfaceSplit, sendCommand, sendLongCommand, readScreen, readScreenAsync, closeSurface, shellEscape };

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "antigravity/gemini-3.7-flash";
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

export function getAvailableBackends(): string[] {
  return isMuxAvailable() ? ["tmux"] : [];
}

export function focusSurface(surface: string): void {
  execFileSync("tmux", ["select-pane", "-t", surface], { encoding: "utf8" });
}

export async function waitForFocusedSurface(surface: string, timeout: number = PI_TIMEOUT): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const active = execFileSync("tmux", ["list-panes", "-F", "#{pane_id} #{pane_active}"], { encoding: "utf8" })
      .split("\n")
      .find((line) => line.trimEnd().endsWith(" 1"));
    if (active?.split(" ")[0] === surface) return;
    await sleep(200);
  }
  throw new Error(`Timeout waiting for focused tmux pane ${surface}`);
}

export interface TestEnv {
  dir: string;
  surfaces: string[];
  tempFiles: string[];
}

export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "iss-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
    }
  }
  return { dir, surfaces: [], tempFiles: [] };
}

export function cleanupTestEnv(env: TestEnv): void {
  for (const surface of env.surfaces) {
    try {
      closeSurface(surface);
    } catch {}
  }
  for (const file of env.tempFiles) {
    try {
      if (file && file.startsWith(tmpdir()) && existsSync(file)) {
        unlinkSync(file);
      }
    } catch {}
  }
  try {
    // Guard against accidental removal of directories outside the test prefix.
    if (env.dir && env.dir.startsWith(tmpdir()) && env.dir.includes("iss-integ-") && env.dir !== tmpdir() && env.dir !== "/") {
      rmSync(env.dir, { recursive: true, force: true });
    }
  } catch {}
}

export function createTrackedSurface(env: TestEnv, name: string): string {
  const surface = createSurface(name);
  env.surfaces.push(surface);
  return surface;
}

export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

export function startPi(surface: string, testDir: string, task: string, opts?: { model?: string; extraArgs?: string }): void {
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";
  const cmd = [
    `cd ${shellEscape(testDir)} &&`,
    `pi`,
    `-e ${shellEscape(EXTENSION_SOURCE)}`,
    `--model ${shellEscape(model)}`,
    extra,
    shellEscape(task),
  ]
    .filter(Boolean)
    .join(" ");
  sendLongCommand(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(2000);
  }
  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(`Timeout waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`);
}

export async function waitForFile(path: string, timeout: number = PI_TIMEOUT, contentPattern?: RegExp): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for file: ${path}${contentPattern ? ` matching ${contentPattern}` : ""}`);
}

export async function waitForPiExit(surface: string, timeout: number = PI_TIMEOUT): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
