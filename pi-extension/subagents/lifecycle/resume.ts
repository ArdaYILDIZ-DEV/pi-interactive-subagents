/**
 * Subagent resume: reboots a finished session by name in a fresh pane.
 *
 * Safety invariant: resume is refused unless the original sandbox snapshot
 * (tool allowlist, model, spawnable agents) is still on disk, so a resume
 * can never silently escalate to the full toolset. Global state stays in
 * `index.ts`; callers inject it via deps.
 */
import { dirname, join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
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
  stopDispatcherTimers,
  type AttachDeps,
} from "./dispatcher.ts";
import { assertLaunchActive, type LaunchContext, type LaunchControl } from "./launch.ts";
import type { RunningSubagent } from "../index.ts";
import type { SubagentMessageDetails } from "../index.ts";
import { readPiParentSession } from "../pi-compat.ts";

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
  control?: LaunchControl,
): {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentMessageDetails;
} {
  const sessionPath = entry.sessionFile;
  const loadout = readSubagentLoadout(sessionPath);
  if (!loadout) {
    const err =
      `Cannot safely resume "${name}": sandbox snapshot is missing or invalid. ` +
      `The original tool and spawn restrictions cannot be verified, so resuming is refused. ` +
      `Re-run the task as a fresh subagent.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err },
    };
  }

  assertLaunchActive(control);
  const id = Math.random().toString(16).slice(2, 10);
  const startTime = Date.now();
  const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? name;
  const parent = readPiParentSession(ctx);
  const artifactDir = getArtifactDir(parent.sessionDir, parent.sessionId);
  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  const dispatcherDeps: AttachDeps = {
    runningSubagents,
    updateWidget: deps.updateWidget,
    getPi: deps.getPi,
  };
  const parts = buildSubagentCliParts(sessionPath, loadout, {
    artifactDir,
    name,
  });

  let resumeMsgFile: string | undefined;
  if (message) {
    resumeMsgFile = writeResumeMessageArtifact(artifactDir, name, message);
    parts.push(shellEscape(`@${resumeMsgFile}`));
  }

  const safeName = sanitizeSubagentName(name, "resume");
  const launchScriptFile = join(
    artifactDir, "subagent-scripts", `${safeName}-resume-${Date.now()}.sh`,
  );
  assertLaunchActive(control);
  // A resumed run must not inherit completion or question signals from its predecessor.
  for (const suffix of ["done", "exit", "ask"]) rmSync(`${sessionPath}.${suffix}`, { force: true });
  const surface = createSurface(name);
  let running: RunningSubagent | undefined;
  try {
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

    assertLaunchActive(control);
    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: buildScriptPreamble("resume", name, sessionPath, surface),
    });
    assertLaunchActive(control);

    running = {
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
    startWidgetRefreshLater(dispatcherDeps);
    startStatusSupervision(dispatcherDeps);

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
  } catch (error: unknown) {
    running?.abortController?.abort();
    runningSubagents.delete(id);
    if (runningSubagents.size === 0) stopDispatcherTimers();
    try {
      closeSurface(surface, control?.isActive?.() !== false);
    } catch {
      // Cleanup is best-effort if the multiplexer itself is unavailable.
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resume subagent "${name}" (${surface}): ${detail}. Pane cleanup was attempted.`);
  }
}
