/**
 * Session file parsing, sandbox loadout persistence, and name registry management.
 *
 * Designed without external dependencies for standalone unit testability.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    stopReason?: string;
    errorMessage?: string;
  };
}

/**
 * Snapshot of a subagent's sandbox configuration.
 * Replayed on session resume to maintain original model, prompt, and tool constraints.
 */
export interface SubagentLoadout {
  agent: string | null;
  toolAllowlist: string | null;
  model: string | null;
  thinking: string | null;
  systemPromptMode: "append" | "replace" | null;
  identity: string | null;
  spawnable: string[] | null;
  autoExit: boolean;
  cwd: string | null;
  agentDir: string | null;
}

export interface NameRegistryEntry {
  sessionFile: string;
  sessionId: string | null;
}
export type NameRegistry = Record<string, NameRegistryEntry>;

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(key: string): boolean {
  return typeof key === "string" && key.length > 0 && !UNSAFE_OBJECT_KEYS.has(key);
}

function hasNullByte(path: string): boolean {
  return typeof path === "string" && path.includes("\0");
}

// ── Session header helpers ──

function readFirstLine(path: string, maxBytes = 65536): string | null {
  if (hasNullByte(path)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a);
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ensure fd cleanup doesn't swallow the original error from the outer try.
      }
    }
  }
}

/** Reads the session identifier from the leading JSON line of a session file. */
export function getSessionId(sessionFile: string): string | null {
  const line = readFirstLine(sessionFile)?.trim();
  if (!line) return null;
  try {
    const entry = JSON.parse(line) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * Writes a fresh session header for a child subagent, recording the parent session path
 * for lineage tracing. Does not copy any messages from the parent.
 */
export function seedSubagentSessionFile(params: {
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
  header?: {
    type: "session"; version?: number; id: string; timestamp: string;
    cwd: string; parentSession?: string;
  };
}): void {
  if (hasNullByte(params.childSessionFile) || hasNullByte(params.parentSessionFile)) return;
  // Retain the v3 seed for legacy callers; runtime launches supply a public SDK header.
  const header = params.header ?? {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, JSON.stringify(header) + "\n", { encoding: "utf8", flag: "wx" });
}

// ── Loadout snapshot ──

export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  if (hasNullByte(sessionFile)) return;
  try {
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
  } catch {
    // Non-fatal: a missing loadout sidecar only prevents future session resumption.
  }
}

function isSubagentLoadout(value: unknown): value is SubagentLoadout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const nullableStringFields = [
    "agent", "toolAllowlist", "model", "thinking", "identity", "cwd", "agentDir",
  ];
  for (const key of nullableStringFields) {
    const field = record[key];
    if (field !== null && (typeof field !== "string" || field.includes("\0"))) return false;
    if (typeof field === "string" && key !== "identity" && !field.trim()) return false;
  }
  if (typeof record.toolAllowlist === "string" &&
      record.toolAllowlist.split(",").some((name) => !name.trim())) return false;
  if (record.systemPromptMode !== null && record.systemPromptMode !== "append" &&
      record.systemPromptMode !== "replace") return false;
  if (typeof record.autoExit !== "boolean") return false;
  const spawnable = record.spawnable;
  return spawnable === null || (Array.isArray(spawnable) && spawnable.every(
    (name: unknown) => typeof name === "string" && name.trim().length > 0 && !name.includes("\0"),
  ));
}

export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  if (hasNullByte(sessionFile)) return null;
  try {
    const sidecarPath = loadoutSidecarPath(sessionFile);
    if (!existsSync(sidecarPath)) return null;
    const parsed = JSON.parse(readFileSync(sidecarPath, "utf8"));
    return isSubagentLoadout(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── Name registry (atomic writes & prototype pollution protection) ──

export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

export function readNameRegistry(artifactDir: string): NameRegistry {
  if (hasNullByte(artifactDir)) return {};
  try {
    const registryPath = nameRegistryPath(artifactDir);
    if (!existsSync(registryPath)) return {};
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: NameRegistry = {};
    for (const key of Object.keys(parsed)) {
      if (!isSafeKey(key)) continue;
      const entry = (parsed as Record<string, unknown>)[key];
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const sessionFile = (entry as Record<string, unknown>).sessionFile;
        const sessionId = (entry as Record<string, unknown>).sessionId;
        if (typeof sessionFile === "string") {
          clean[key] = {
            sessionFile,
            sessionId: typeof sessionId === "string" ? sessionId : null,
          };
        }
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  if (hasNullByte(artifactDir) || !isSafeKey(name)) return;
  try {
    mkdirSync(artifactDir, { recursive: true });
    const registry = readNameRegistry(artifactDir);
    registry[name] = {
      sessionFile: entry.sessionFile,
      sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
    };
    const targetPath = nameRegistryPath(artifactDir);
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    writeFileSync(tmpPath, JSON.stringify(registry, null, 2), "utf8");
    renameSync(tmpPath, targetPath);
  } catch {
    // Non-fatal: registry write failures only affect resume-by-name lookups.
  }
}

export function resolveNameInRegistry(
  artifactDir: string,
  name: string,
): NameRegistryEntry | null {
  if (hasNullByte(artifactDir) || !isSafeKey(name)) return null;
  const registry = readNameRegistry(artifactDir);
  if (Object.prototype.hasOwnProperty.call(registry, name)) {
    const exact = registry[name];
    if (exact && typeof exact.sessionFile === "string") {
      return exact;
    }
  }
  // Fall back to case-insensitive lookup if exact match is not found.
  const lower = name.toLowerCase();
  for (const registeredName of Object.keys(registry)) {
    if (registeredName.toLowerCase() === lower) {
      const entry = registry[registeredName];
      if (entry && typeof entry.sessionFile === "string") {
        return entry;
      }
    }
  }
  return null;
}

// ── Entry helpers (single-pass line scanning) ──

/** Stream parseable JSON lines; offsets count nonblank lines, including malformed ones. */
function* parsedSessionLines(raw: string, afterLine = 0): Generator<unknown> {
  let lineStart = 0;
  let nonBlankIndex = 0;
  while (lineStart < raw.length) {
    let lineEnd = raw.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = raw.length;
    let start = lineStart;
    let end = lineEnd;
    while (start < end && raw.charCodeAt(start) <= 32) start++;
    while (end > start && raw.charCodeAt(end - 1) <= 32) end--;
    lineStart = lineEnd + 1;
    if (start >= end) continue;
    if (nonBlankIndex++ < afterLine) continue;
    try {
      yield JSON.parse(raw.substring(start, end));
    } catch {
      // Ignore malformed or partially flushed lines without retaining all entries.
    }
  }
}

/** Parses entries after a nonblank-line offset without allocating a split-line array. */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  if (hasNullByte(sessionFile)) return [];
  try {
    return [...parsedSessionLines(readFileSync(sessionFile, "utf8"), afterLine)] as SessionEntry[];
  } catch {
    return [];
  }
}

/** Counts parseable JSON lines without retaining parsed objects in memory. */
export function countSessionEntryLines(sessionFile: string): number {
  if (hasNullByte(sessionFile)) return 0;
  try {
    let count = 0;
    for (const _entry of parsedSessionLines(readFileSync(sessionFile, "utf8"))) count++;
    return count;
  } catch {
    return 0;
  }
}

/**
 * Returns the text of the last assistant message in the session, or an error
 * summary when the final turn ended with stopReason=error. Returns null when
 * no qualifying message exists.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (!msg || msg.role !== "assistant") continue;

    const content = msg.content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((block) => block && block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
        .map((block) => block.text as string);
      if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");
    }

    const stopReason = msg.stopReason;
    const errorMessage = msg.errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}

export interface SessionStats {
  model: string | null;
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  cost: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function accumulateEntryStats(entry: unknown, stats: SessionStats): void {
  if (!entry || typeof entry !== "object") return;
  const item = entry as Record<string, unknown>;
  if (item.type === "model_change") {
    const modelId = item.modelId;
    if (typeof modelId === "string" && modelId) stats.model = modelId;
    return;
  }
  if (item.type !== "message") return;
  const msg = item.message as Record<string, unknown> | undefined;
  if (!msg || msg.role !== "assistant") return;
  const model = msg.model;
  if (typeof model === "string" && model) stats.model = model;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall") {
        stats.toolCount++;
      }
    }
  }
  const usage = msg.usage;
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    stats.inputTokens += num(u.input);
    stats.outputTokens += num(u.output);
    stats.cacheReadTokens += num(u.cacheRead);
    stats.cacheWriteTokens += num(u.cacheWrite);
    const total = num(u.totalTokens);
    if (total > 0) stats.contextTokens = total;
    const cost = u.cost;
    if (cost && typeof cost === "object") {
      stats.cost += num((cost as Record<string, unknown>).total);
    }
  }
}

function emptySessionStats(): SessionStats {
  return {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };
}

/**
 * Summarizes cumulative token usage, tool call counts, context window size, and cost.
 * Performs a single-pass line scan when given a file path, or summarizes an existing
 * SessionEntry array directly without disk I/O.
 */
export function summarizeSessionStats(sessionFileOrEntries: string | SessionEntry[]): SessionStats | null {
  let entries: Iterable<unknown>;
  if (Array.isArray(sessionFileOrEntries)) {
    entries = sessionFileOrEntries;
  } else {
    if (typeof sessionFileOrEntries !== "string" || hasNullByte(sessionFileOrEntries)) return null;
    try {
      entries = parsedSessionLines(readFileSync(sessionFileOrEntries, "utf8"));
    } catch {
      return null;
    }
  }
  const stats = emptySessionStats();
  for (const entry of entries) accumulateEntryStats(entry, stats);
  return stats;
}
