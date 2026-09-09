# interactive-subagents

Interactive subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes.

Spawn a sub-agent, keep working in the main session, and get the result steered back
when it finishes. Fully non-blocking.

## What it does

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right
split off the parent pi pane, so pane creation never steals keyboard focus. A live
widget above the editor tracks every running sub-agent, and when one finishes, its
result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 23s  scout (scout)                          active │
│ 1m 23s  dark-mode (worker)                 waiting │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back
independently as each finishes.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes it if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory for the subagent (defaults to current directory or agent's defined `cwd`) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and
persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately.
- **Finished** — the session is resumed with the message as the follow-up task, always autonomous; the result is steered back later. **Resume replays the original sandbox** from a `<session>.loadout.json` snapshot (tool allowlist, model, identity, spawn whitelist, cwd), so a resumed run never silently escalates to a full-toolset process.

## Tool access control

Sub-agent processes run with full extension discovery enabled so all user and project extensions remain available. Tool permissions are configured directly via the `tools` field in each agent's frontmatter:

- When `tools` is specified, `pi` is invoked with `--tools <allowlist>`, exposing only those tools to the agent.
- When omitted, the agent has access to all available tools.

Spawns must name a known agent at **every** depth:

- A top-level session may spawn anything discoverable.
- A sub-agent may only spawn the agents in its `subagent_agents` list (enforced via
  `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `opencode/muse-spark-1.2-contributor-free` | `read`, `grep`, `find`, `ls`, `safe_bash` | Fast read-only codebase recon |
| **researcher** | `opencode/muse-spark-1.2-contributor-free` | `web_search`, `fetch_content`, `get_search_content`, `source_check`, `web_fetch`, `read`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `antigravity/gemini-3.7-flash` | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web_search`, `fetch_content`, `get_search_content`, `web_fetch`, `source_check`, `todo` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global).
Discovery priority: **project > global > package-bundled**.

```markdown
---
name: my-agent
description: Does something specific
model: antigravity/gemini-3.7-flash
thinking: medium
tools: read, edit, write, safe_bash, web_search
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Tool allowlist (passed via `--tools`). Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` plus any extension tools you have installed (e.g. `web_search`, `web_fetch`, `safe_bash`, etc.). Omit to allow all tools |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent's turn ends (recommended for all autonomous agents) |
| `interactive` | boolean | Defaults to the inverse of `auto-exit`; user-driven agents stay quiet on stall pings |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child:
`starting`, `active`, `waiting`, or `stalled` (no valid snapshot for too long).

Status display is configured via `config.json` in the package directory. A `config.json.example`
is provided; copy it to `config.json` to customize the widget. **If `config.json` is absent,
the extension falls back to safe in-code defaults (`enabled: true`, `lineLimit: 4`, `stallAfterMs: 180000`)** rather than failing to load.

```json
{
  "status": {
    "enabled": true,
    "lineLimit": 4,
    "stallAfterMs": 180000
  }
}
```

### Configuration fields

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `status.enabled` | boolean | `true` | Show or hide the live status widget above the editor |
| `status.lineLimit` | number | `4` | Maximum number of concurrent subagent status rows rendered |
| `status.stallAfterMs` | number | `180000` | Milliseconds without activity updates before a subagent is shown as stalled |

## Requirements & Installation

- [pi](https://github.com/badlogic/pi-mono) (`@earendil-works/pi-coding-agent`)
- [tmux](https://github.com/tmux/tmux) (2.6+)

### Installation

Pi automatically discovers extensions in `~/.pi/agent/extensions/<package-name>/` via the `"pi": { "extensions": [...] }` manifest in `package.json`.

#### Option A: Clone into extensions directory

```bash
git clone https://github.com/ArdaYILDIZ-DEV/pi-interactive-subagents.git ~/.pi/agent/extensions/interactive-subagents
```

#### Option B: Symlink local repository

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)" ~/.pi/agent/extensions/interactive-subagents
```

### Agent Definitions Setup

- **Bundled agents:** Out of the box, `scout`, `researcher`, and `worker` are auto-discovered directly from the extension package's `agents/` directory.
- **Global customizations:** Place or copy `.md` files in `~/.pi/agent/agents/` to define or customize agents available across all workspaces:

  ```bash
  mkdir -p ~/.pi/agent/agents
  cp agents/*.md ~/.pi/agent/agents/   # optional: override global defaults
  ```

- **Project-specific agents:** Place `.md` files in `.pi/agents/` in any project root to define workspace-scoped agents.
- **Discovery priority:** **`project (.pi/agents/)` > `global (~/.pi/agent/agents/)` > `package-bundled (agents/)`**.

### Usage

Start `pi` inside a tmux session:

```bash
tmux new -A -s pi 'pi'
```

## Notable fixes & improvements

- **Instant automatic pane destruction.** The child shell executes with exit trapping; upon turn completion, a `.done` sidecar triggers immediate pane teardown (`kill-pane`) so terminal splits never linger after subagents finish.
- **Bi-directional `ask_question` support.** Subagents can call `ask_question` to pause and request clarification from the orchestrator. Questions are rendered into an interactive alert and can be replied to via `subagent_message`.
- **Full extension discovery & flexible tool allowlisting.** Subagents inherit all installed Pi extensions without `--no-extensions` lockout, while tool access is governed strictly by the frontmatter `tools` field.
- **Nested subagent spawning support.** Spawning-enabled subagents (like `worker`) inherit tmux environment variables (`TMUX`, `TMUX_PANE`) and spawning tools to seamlessly orchestrate child subagents.
- **Config no longer crashes the extension.** The status widget falls back to a safe default (`enabled: true`) when `config.json` is missing.
- **Watcher leak prevention & pane liveness checks.** `pollForExit` monitors pane liveness and sidecars to eliminate hanging watcher loops.
- **`safe_bash` safety hardening.** Recursive deletions targeting root, home directory, parent directories, wildcards, and disk formatting commands are strictly intercepted and blocked.

## Tests

Unit tests cover the dependency-free core (session parsing, the name registry, the loadout
snapshot, status classification, the sandbox builder, the activity recorder, and the
`safe_bash` danger matcher). They need no pi/tmux and run without installing dependencies:

```bash
npm test
# or: node --test test/unit/*.test.ts
```

Integration tests (`test/integration/`) drive real pi sessions inside tmux with real LLM
calls. Run them inside a tmux session:

```bash
tmux new 'npm run test:integration'
```
