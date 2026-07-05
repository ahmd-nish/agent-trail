# agent-trail

> The kanban board where AI coding agents do the work — and you make the calls.

Drop a PRD → get a structured task graph → watch Claude Code execute each task in an isolated git worktree, under a TDD gate, with live telemetry → get pinged only when the agent needs a human decision.

**Status:** v1.0.0 · MIT licensed · local-first (SQLite, nothing leaves your machine)

<!-- DEMO GIF HERE — cinematic feed: PRD drop → agents running → decision ticket → tests green -->

---

## Why agent-trail?

Running one coding agent in a terminal is easy. Running *several*, on real work, without losing the plot — that's the hard part. Most boards show you *that* an agent is running; agent-trail closes three loops nobody else does:

1. **A TDD gate** — a task cannot reach *Done* until its tests actually pass. A suite that runs zero tests does not count as a pass.
2. **Human decision tickets** — when an agent hits a judgment call, it pauses and asks *you* via the `ask_human` MCP tool. You answer on the card; it resumes. No babysitting, no silent guessing.
3. **Structured agent assignment** — bind MCP servers, skills, and subagents per task as real fields, not free-text prayers.

## Features

- **PRD → task graph** — paste a requirements doc, get a dependency-ordered DAG on a 6-column kanban
- **Parallel execution in worktrees** — up to 3 concurrent tasks, each in its own git worktree; no diff collisions
- **TDD gate** — enforced `write_tests → implement → verify_tests`; bun / jest / vitest / pytest auto-detected
- **`ask_human` decision loop** — agent pauses, card shows the question, your answer unblocks it
- **Live activity feed** — tool calls, streaming text, and telemetry (tokens, duration) over SSE; typewriter text, sounds, command palette (⌘K)
- **Per-task MCP / skill / subagent binding** — auto-discovers `.claude/agents/` and `.mcp.json`; bundled subagents included
- **Post-execution artifacts** — git diff, test output, and modified-file list captured on every run
- **Board MCP server** — the board itself is an MCP server, so Claude Code can manage tasks programmatically
- **Run the whole board** — ▶ Run all executes the backlog in DAG order
- **Webhooks** — notifications on completion, failure, and awaiting-human

## Prerequisites

- [Bun](https://bun.sh) >= 1.1.0
- [Claude Code CLI](https://claude.ai/download) installed and authenticated (`claude login`) — used for **both** the planner and task execution

## Quickstart

```bash
git clone https://github.com/ahmd-nish/agent-trail.git
cd agent-trail
bun install

# Start the API server
bun run dev:server          # http://localhost:3002

# In a second terminal, start the web UI
bun run dev:web             # http://localhost:5173
```

Open http://localhost:5173, create a board, paste a PRD (or use `examples/sample-prd.md`), and click **▶ Run** on any task.

## CLI

```bash
bun cli init                                          # start server + open browser
bun cli plan examples/sample-prd.md --name "URL Shortener"   # PRD → new board
bun cli plan examples/sample-prd.md --dry-run         # print task graph without saving
bun cli plan examples/sample-prd.md --board <boardId> # add tasks to existing board
bun cli start <taskId>                                # watch a task execute live
bun cli status                                        # all boards + task counts
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        agent-trail                           │
│                                                             │
│  ┌───────────┐   ┌───────────────┐   ┌──────────────────┐   │
│  │  Planner  │   │  Hono server  │   │ Execution manager│   │
│  │  PRD→DAG  │──▶│  + SQLite     │──▶│  (max 3 concurrent│  │
│  │           │   │  REST + SSE   │   │   worktrees)     │   │
│  └───────────┘   └───────────────┘   └────────┬─────────┘   │
│                                               │             │
│                                    ┌──────────▼──────────┐  │
│                                    │  claude --output-   │  │
│                                    │  format stream-json │  │
│                                    └──────────┬──────────┘  │
│                                               │             │
│                              ┌────────────────▼──────────┐  │
│                              │  Per-task MCP config      │  │
│                              │  ask_human + task MCPs    │  │
│                              └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Packages** (Bun workspaces):

| Package | Purpose |
|---------|---------|
| `@agent-trail/core` | Types, DAG planner, Claude Code adapter, MCP servers, test runner, agent discovery |
| `@agent-trail/server` | Hono API + execution manager + SSE bus + decision tickets |
| `@agent-trail/web` | React 18 kanban board (Vite + Tailwind v4 + @dnd-kit) |
| `@agent-trail/cli` | `agent-trail` CLI — init, plan, start, status |

## How it works

1. **Planner** calls the claude CLI with a `create_task_graph` tool, returning a validated DAG of tasks with priorities and dependencies
2. **Execution manager** spawns `claude -p <prompt> --output-format stream-json --verbose` per task in a git worktree, with a phase-specific system prompt appended
3. **SSE bus** broadcasts `tool_call`, `text`, `test_result`, and `awaiting_human` events to all subscribers in real time
4. **ask_human MCP** — when Claude calls `ask_human(question)`, the server writes a decision ticket, the UI shows an amber decision card, and execution resumes once you answer
5. **Post-execution** captures `git diff HEAD` and `git status --porcelain` as artifacts, visible in the task detail panel

## TDD gate

Enable the TDD gate on any task to enforce a 3-phase lifecycle:

```
write_tests   → Claude writes failing tests only
implement     → Claude writes code to make tests pass
verify_tests  → test runner executes directly (no Claude); green suite → in_review
```

Supported runners: bun (default), jest, vitest, pytest — auto-detected from `package.json` + config files.

## Board MCP server

Expose the board as tools so Claude Code can manage tasks programmatically:

```bash
bun mcp:board
```

Or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-trail": {
      "command": "bun",
      "args": ["packages/core/src/mcp/board-server.ts"],
      "env": { "AGENT_TRAIL_DB_PATH": "/absolute/path/to/agent-trail.db" }
    }
  }
}
```

**Available tools:** `list_tasks`, `get_task`, `update_task_status`, `add_task`

## Roadmap

- **v1.1** — versioned stream-json compat layer · second agent adapter (Codex / Gemini CLI) · crash-resume · per-task cost budgets · commit agent · auto-PR · headless CI mode
- **v1.2** — git-native team context: your team's decisions and conventions live in the repo, and every agent inherits them
- **v1.3** — agent/skill registry imports · planner auto-assignment · context orchestrator · model routing · loop policies

Check [open issues](https://github.com/ahmd-nish/agent-trail/issues) — `good first issue` labels are real and scoped. Writing a new agent adapter is the highest-impact contribution.

## Development

```bash
bun test                    # run all tests
bun probe:claude            # de-risk stream-json parser against live claude CLI
bun run dev:server          # hot-reload API server
bun run dev:web             # Vite HMR web UI
```

## Security

Agents get write access to your repo inside isolated worktrees, and MCP configs are injected per task. Read [SECURITY.md](SECURITY.md) before running on anything sensitive. All telemetry stays in your local SQLite database — nothing phones home.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The build log lives in `docs/` — each day's completion log documents what was built and why.

## License

[MIT](LICENSE)
