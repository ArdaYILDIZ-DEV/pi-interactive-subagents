# interactive-subagents

Pi extension for asynchronous child sessions in tmux panes. The parent owns direct children, relays questions, and receives completion messages; children do not inherit the parent's conversation. Use source and agent definitions as behavioral evidence, not stale README claims.

## Working commands

Run from this repository root with the locked development dependencies available:

- `npm test` — all unit tests; no live tmux server, credentials, or LLM calls. Lifecycle tests use a fake tmux executable.
- `node --test test/unit/session.test.ts` — focused unit file; substitute the relevant test filename.
- `npx tsc --noEmit` — strict TypeScript check.
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` — additional unused-symbol check, including tests.
- `npm run test:integration` — serial real-Pi/LLM tests inside tmux. These use configured provider credentials and may consume quota/cost; inspect the harness before running. A skipped suite does not verify integration.

The full unit suite imports Pi/TypeBox; dependency-free core modules do not make the entire suite dependency-free. Do not edit `node_modules/`, secrets, `config.json.example`, or `tsconfig.json`. If dependencies are absent, report that or use an isolated dependency-equipped test environment rather than altering protected files.

## Where changes belong

- `pi-extension/subagents/index.ts`: extension entry point; owns `runningSubagents`, current Pi/context handles, and shutdown. Public re-exports are compatibility surface, not dead code merely because internal callers are absent.
- `agents/discovery.ts` and package `agents/*.md`: profile parsing and project > global > bundled discovery. Tool permissions, model/thinking, prompt mode, and spawn targets come from the winning profile. Blank fields must not consume subsequent keys.
- `cli/args.ts`, `sandbox.ts`, `lifecycle/seed.ts`: shell-safe command/environment construction, saved loadout replay, task/prompt artifacts, and cwd selection.
- `lifecycle/launch.ts`, `resume.ts`, `steer.ts`, `watch.ts`, `dispatcher.ts`: launch/control, follow-ups, completion supervision, and parent delivery. Inject state hooks; do not introduce a second owner of the running map.
- `tmux.ts`: all multiplexer operations. Guard interactions with `isMuxAvailable()`; delayed layout callbacks must also respect runtime/environment teardown.
- `subagent-done.ts`: child lifecycle, `ask_question`, activity reporting, and completion sidecars. `registry.ts` shares the running-child count across loaded extension copies.
- `session.ts`, `activity.ts`, `status.ts`: persisted data, telemetry, and configuration. Keep these and discovery/env/CLI/sandbox helpers free of external runtime dependencies (only `node:*` and local core modules).
- `tools/`: parent tool registration and regex-filtered `safe_bash`. `tui/`: pure formatting plus renderer/widget registration; terminal widgets are TUI-only.

## Behavioral contracts to preserve

- `subagent` returns after launch; results/questions arrive through parent `sendMessage` with `triggerTurn: true, deliverAs: "steer"`. Do not add synchronous waiting to tool calls.
- Spawning selects a named profile in the parent cwd; explicit child cwd changes the child's environment, not that selection. A missing named profile must not silently launch unrestricted. Nonempty `subagent_agents` grants orchestration and restricts targets; defaults are not a universal fixed worker-only hierarchy.
- Display names and agent names are separate. Returned display names are reserved across concurrent launches and persisted for finished children; messaging uses the parent's name registry. Preserve exact-name precedence and same-session steering before resume.
- New sessions store lineage only. Resume preserves the child's history and replays its validated `.loadout.json`; missing/invalid snapshots refuse resume. Resume always auto-exits. Keep original tools, spawn targets, identity, model/thinking, cwd, and agent directory intact.
- Live steering is terminal input with flattened newlines, not an atomic IPC acknowledgment or cancellation. `ask_question` returns after writing one sidecar; the child must stop while its awaiting-answer flag prevents auto-exit.
- Autonomous completion happens at `agent_settled`, not `agent_end`. Pending questions, running descendants, and aborted turns must stay open. Settlement/shutdown deadlines bound lifecycle transitions, not task duration.
- Child writes `.done`, `.exit`, `.ask`, and `.loadout.json`; parent watchers consume transient signals. Failure wins over stale success. A vanished pane without completion evidence is an unknown failure. Shutdown must abort watchers, cancel timers, close tracked panes, and suppress late delivery.
- Watch summaries use the SDK's active branch; statistics are cumulative over all session entries. Legacy sessions are restored/migrated in memory without rewriting source files. Preserve nonblank-line offset semantics, malformed-line handling, and streaming stats/counting in `session.ts`.
- `safe_bash` is a regex danger filter, not OS isolation or a read-only guarantee. Heartbeat freshness is not proof of task progress. Do not infer provider retry exhaustion or absence of partial work from a generic watcher error.

## Compatibility and coupled changes

`package.json` and the lockfile are authoritative for dependency versions. The tested Pi baseline is 1.0.1; runtime support is stable Pi >=1.0.1 <2.0.0 with public `typebox`. Use public Pi exports, not deep package imports or the legacy `@sinclair/typebox` alias. Add no runtime dependencies beyond `node:*` and existing packages.

Keep explicit `.ts` relative imports. Preserve exported signatures, legacy helpers, and snapshot formats unless a behavior/API change is explicitly part of the task. For moves, keep existing `index.ts` re-exports. Test-only hooks must not be consumed by runtime code.

For lifecycle/permission changes, cover failure cleanup and the corresponding resume path, not only a successful launch. Update relevant README claims when behavior or configuration changes. The associated skill lives outside this repo at `~/.pi/agent/skills/how-to-use-subagents/SKILL.md`; when changing its documented contracts, recheck its claims and keep the complete UTF-8 file at or below 8192 bytes.

`status.lineLimit` and runtime `interactive` metadata are retained compatibility fields, not permission to silently repurpose behavior. Currently all agent rows render; `status.enabled` toggles activity supervision/labels, not widget visibility.

## Git scope

This checkout is a submodule of the parent agent repository. Commit source changes here and update its parent gitlink only when that commit work is authorized. The skill belongs to the parent repository. `AGENTS.md` is currently ignored; do not force-add it or change ignore rules merely to publish guidance.

Commit/push only when explicitly requested, stage only intended changes, and use English Conventional Commits without AI-attribution trailers. Commit permission does not include push permission.
