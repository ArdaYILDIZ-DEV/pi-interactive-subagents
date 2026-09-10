/**
 * Subagent resume: reboots a finished session by name in a fresh pane.
 *
 * Safety invariant: resume is refused unless the original sandbox snapshot
 * (tool allowlist, model, spawnable agents) is still on disk, so a resume
 * can never silently escalate to the full toolset. Global state stays in
 * `index.ts`; callers inject it via deps.
 */
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeSurface, createSurface, sendLongCommand, shellEscape } from "../tmux.ts";
import {
  getSessionId,
  readSubagentLoadout,
  type NameRegistryEntry,
} from "../session.ts";
import { getSubagentActivityFile } from "../activity.ts";
import { sanitizeSubagentName } from "../sandbox.ts";
import { getArtifactDir, writeResumeMessageArtifact } from "./seed.ts";
import {
  buildSubagentEnv,
  buildScriptPreamble,
  buildSubagentCliParts,
  buildSubagentCommand,
} from "../cli/args.ts";
import {
  attachSubagentWatcher,
  startStatusSupervision,
  startWidgetRefreshLater,
  type AttachDeps,
} from "./dispatcher.ts";
import type { LaunchContext } from "./launch.ts";
import type { RunningSubagent } from "../index.ts";
import type { SubagentMessageDetails } from "../index.ts";

/**
 * Relaunches a finished session under its registered name with an optional
 * follow-up message. Always auto-exits; resumed panes are never interactive.
 *
 * @param name Registered display name to resume under.
 * @param message Follow-up task delivered as `@file` on reboot, if any.
 * @param entry Name-registry record pointing at the prior session file.
 * @param _parentArtifactDir Kept for call-site compatibility; the resume
 *   artifacts live in the current session dir, not the parent one.
 * @param ctx Parent session handles plus working directory.
 * @param pi Extension host used to deliver the eventual result.
 * @param runningSubagents Extension-owned map receiving the new record.
 * @param deps Widget refresh plus live parent handle.
 * @returns Tool result content with a `started` status or refusal error.
 */
export function resumeSubagent(
  name: string,
  message: string | undefined,
  entry: NameRegistryEntry,
  _parentArtifactDir: string,
  ctx: LaunchContext,
  pi: ExtensionAPI,
  runningSubagents: Map<string, RunningSubagent>,
  deps: Omit<AttachDeps, "runningSubagents">,
): {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentMessageDetails;
} {
  const sessionPath = entry.sessionFile;
  const loadout = readSubagentLoadout(sessionPath);
  if (!loadout) {
    const err =
      `Cannot safely resume "${name}": no sandbox snapshot found. Resuming would relaunch with all ` +
      `global extensions and the full toolset, so this is refused. Re-run the task as a fresh subagent.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err },
    };
  }

  const id = Math.random().toString(16).slice(2, 10);
  const startTime = Date.now();
  const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? name;
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    sessionId,
  );
  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  const surface = createSurface(name);
  const dispatcherDeps: AttachDeps = {
    runningSubagents,
    updateWidget: deps.updateWidget,
    getPi: deps.getPi,
  };
  startStatusSupervision(dispatcherDeps);
  void startWidgetRefreshLater(dispatcherDeps);

  const parts = buildSubagentCliParts(sessionPath, loadout, {
    artifactDir,
    name,
  });

  let resumeMsgFile: string | undefined;
  if (message) {
    resumeMsgFile = writeResumeMessageArtifact(artifactDir, name, message);
    parts.push(shellEscape(`@${resumeMsgFile}`));
  }

  const envParts = buildSubagentEnv({
    surface,
    sessionFile: sessionPath,
    id,
    name,
    activityFile,
    agent: loadout.agent,
    agentDir: loadout.agentDir,
    allowedAgents: loadout.spawnable,
    autoExit: true,
  });

  const command = buildSubagentCommand({
    cwd: loadout.cwd,
    envParts,
    parts,
  });

  const safeName = sanitizeSubagentName(name, "resume");
  const launchScriptFile = join(
    artifactDir,
    "subagent-scripts",
    `${safeName}-resume-${Date.now()}.sh`,
  );
  try {
    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: buildScriptPreamble("resume", name, sessionPath, surface),
    });
  } catch (error: unknown) {
    // Same orphan-pane + raw-stderr hazard as launch: clean up, then rethrow framed.
    try {
      closeSurface(surface);
    } catch {
      // Pane already gone; cleanup was best-effort.
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to resume subagent "${name}": its tmux pane (${surface}) went away before the resume command could be delivered (${detail}). The orphan pane was cleaned up; retry the resume.`,
    );
  }

  const running: RunningSubagent = {
    id,
    name,
    task: message ?? "",
    agent: loadout.agent ?? undefined,
    surface,
    startTime,
    sessionFile: sessionPath,
    launchScriptFile,
    activityFile,
    interactive: false,
  };
  runningSubagents.set(id, running);

  attachSubagentWatcher(running, pi, dispatcherDeps, {
    isResume: true,
    sessionId: resumedSessionId,
  });

  return {
    content: [{ type: "text" as const, text: `Session "${name}" resumed.` }],
    details: {
      id,
      name,
      sessionId: resumedSessionId,
      sessionFile: sessionPath,
      launchScriptFile,
      status: "started",
    },
  };
}
