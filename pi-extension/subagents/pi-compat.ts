import * as Pi from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getNewEntries, type SessionEntry } from "./session.ts";

export type PiSessionContext = Pick<Pi.ExtensionContext, "cwd"> & {
  sessionManager: Pick<Pi.ExtensionContext["sessionManager"],
    "getSessionFile" | "getSessionId" | "getSessionDir">;
};

function incompatible(detail: string): Error {
  return new Error(`Interactive subagents Pi compatibility error: ${detail} Supported Pi range: >=1.0.1 <2.0.0.`);
}

function assertSupportedPiVersion(version: unknown): void {
  const parsed = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version) : null;
  if (!parsed || Number(parsed[1]) !== 1 || (Number(parsed[2]) === 0 && Number(parsed[3]) < 1)) {
    throw incompatible(`Unsupported host version ${String(version)}.`);
  }
}

export function assertPiExtensionApi(
  value: unknown,
  role: "orchestrator" | "child" | "safe_bash",
): asserts value is Pi.ExtensionAPI {
  assertSupportedPiVersion(Pi.VERSION);
  const required = role === "orchestrator"
    ? ["on", "registerTool", "registerCommand", "registerMessageRenderer", "sendMessage", "sendUserMessage"]
    : role === "child" ? ["on", "registerTool"] : ["registerTool"];
  const record = value as Record<string, unknown> | null;
  for (const name of required) {
    if (!record || typeof record[name] !== "function") throw incompatible(`Missing ExtensionAPI.${name}().`);
  }
}

function sessionSdk(): typeof Pi.SessionManager {
  assertSupportedPiVersion(Pi.VERSION);
  if (typeof Pi.SessionManager !== "function" || typeof Pi.SessionManager.create !== "function" ||
      typeof Pi.SessionManager.inMemory !== "function" || typeof Pi.getAgentDir !== "function" ||
      !Number.isInteger(Pi.CURRENT_SESSION_VERSION) || Pi.CURRENT_SESSION_VERSION < 1) {
    throw incompatible("The public SessionManager, getAgentDir, or session-version export is unavailable.");
  }
  return Pi.SessionManager;
}

function assertSessionManager(value: unknown): asserts value is Pi.SessionManager {
  const record = value as Record<string, unknown> | null;
  for (const name of ["getSessionDir", "getSessionFile", "getHeader", "getSessionId", "getEntries", "getBranch"]) {
    if (!record || typeof record[name] !== "function") throw incompatible(`Missing public SessionManager.${name}().`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw incompatible(`${label} must return a nonempty string without null bytes.`);
  }
  return value;
}

export function readPiParentSession(ctx: unknown): {
  cwd: string; sessionFile: string | undefined; sessionId: string; sessionDir: string;
} {
  const context = ctx as Record<string, unknown> | null;
  const manager = context?.sessionManager as Record<string, unknown> | null;
  const read = (name: string): unknown => {
    if (!manager || typeof manager[name] !== "function") throw incompatible(`Missing sessionManager.${name}().`);
    return (manager[name] as () => unknown).call(manager);
  };
  const file = read("getSessionFile");
  const directory = read("getSessionDir");
  if (typeof directory !== "string" || directory.includes("\0") || (file !== undefined && !directory.trim())) {
    throw incompatible("sessionManager.getSessionDir() returned an invalid directory.");
  }
  return {
    sessionFile: file === undefined ? undefined : requiredString(file, "sessionManager.getSessionFile()"),
    sessionId: requiredString(read("getSessionId"), "sessionManager.getSessionId()"),
    sessionDir: directory,
    cwd: requiredString(context?.cwd, "ExtensionContext.cwd"),
  };
}

/** Derive Pi's storage layout without copying its cwd encoding algorithm. */
export function resolvePiSessionDir(cwd: string, agentDir: string): string {
  const manager = sessionSdk().create(cwd);
  assertSessionManager(manager);
  const directory = requiredString(manager.getSessionDir(), "SessionManager.getSessionDir()");
  const configuredRoot = requiredString(Pi.getAgentDir(), "getAgentDir()");
  if (resolve(agentDir) === resolve(configuredRoot)) return directory;
  const suffix = relative(configuredRoot, directory);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw incompatible("Pi's default session directory is not beneath its configured agent directory.");
  }
  return join(agentDir, suffix);
}

export function createPiSubagentSession(cwd: string, agentDir: string, parentSession: string): {
  sessionFile: string; header: Pi.SessionHeader;
} {
  const manager = sessionSdk().create(cwd, resolvePiSessionDir(cwd, agentDir), { parentSession });
  assertSessionManager(manager);
  const sessionFile = requiredString(manager.getSessionFile(), "SessionManager.getSessionFile()");
  const header = manager.getHeader();
  if (!header || header.type !== "session" || typeof header.id !== "string" ||
      typeof header.timestamp !== "string" || typeof header.cwd !== "string" ||
      header.version !== Pi.CURRENT_SESSION_VERSION || header.parentSession !== parentSession) {
    throw incompatible("SessionManager returned an invalid child session header.");
  }
  return { sessionFile, header };
}

/** Restore and migrate in memory so inspecting an old session never rewrites it. */
export function readPiSessionSnapshot(sessionFile: string): {
  sessionId: string; entries: SessionEntry[]; branch: SessionEntry[];
} {
  const sdk = sessionSdk();
  const raw = getNewEntries(sessionFile, 0);
  const header = raw[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id.trim()) {
    throw incompatible("Invalid or missing session header.");
  }
  const version = header.version;
  if (version !== undefined && (!Number.isInteger(version) || (version as number) < 1 ||
      (version as number) > Pi.CURRENT_SESSION_VERSION)) {
    throw incompatible(`Unsupported session version ${String(version)}.`);
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || typeof entry.type !== "string") {
      throw incompatible("Invalid session entry envelope.");
    }
  }
  const cwd = typeof header.cwd === "string" && header.cwd ? header.cwd : process.cwd();
  // JSON is an untyped boundary; the SDK performs documented legacy migration and tree restoration.
  const manager = sdk.inMemory(cwd, undefined, raw as unknown as Pi.FileEntry[]);
  assertSessionManager(manager);
  const sessionId = requiredString(manager.getSessionId(), "SessionManager.getSessionId()");
  return {
    sessionId,
    entries: manager.getEntries().map((entry) => ({ ...entry })),
    branch: manager.getBranch().map((entry) => ({ ...entry })),
  };
}

export const __test__ = { assertSupportedPiVersion };
