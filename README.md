# agent-trail

> AI-native kanban board that orchestrates Claude Code on real software projects.

Drop a PRD → get a structured task graph → watch Claude Code execute under a TDD gate with live telemetry → get pinged when the agent needs a human decision.

**Status:** v0.1.0 — 7-day MVP complete

---

## Features

- **PRD → task graph** — paste a product requirements doc, get a 6-column kanban with dependency ordering
- **Per-task MCP binding** — assign different MCP servers to different tasks; `ask_human` always available
- **TDD gate** — enforced `write_tests → implement → verify_tests` pipeline (bun/jest/pytest auto-detected)
- **Live telemetry** — stream Claude Code's tool calls and text to the board in real time via SSE
- **Human-in-the-loop** — `ask_human` MCP pauses execution and shows a decision card in the UI
- **Post-execution artifacts** — git diff + file list captured per run, visible in the task panel
- **Board MCP server** — expose the board itself as an MCP server so Claude Code can manage tasks

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        agent-trail                           │
│                                                             │
│  ┌───────────┐   ┌───────────────┐   ┌──────────────────┐   │
│  │  Planner  │   │  Hono server  │   │ Execution manager│   │
│  │  (Sonnet) │──▶│  + SQLite     │──▶│  (max 3 concurrent│  │
│  │  PRD→DAG  │   │  REST + SSE   │   │   worktrees)     │   │
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

**Packages:**

| Package | Purpose |
|---------|---------|
| `@agent-trail/core` | Types, DAG planner, Claude Code adapter, MCP servers, test runner |
| `@agent-trail/server` | Hono API + execution manager + SSE bus |
| `@agent-trail/web` | React 18 kanban board (Vite + Tailwind v4 + @dnd-kit) |
| `@agent-trail/cli` | `agent-trail` CLI — init, start, status |

---

## Prerequisites

- [Bun](https://bun.sh) >= 1.1.0
- [Claude Code CLI](https://claude.ai/download) installed and authenticated (`claude login`)
- `ANTHROPIC_API_KEY` set in your environment (for the PRD planner)

---

## Quickstart

```bash
git clone https://github.com/your-handle/agent-trail
cd agent-trail
bun install

# Start the API server
bun run dev:server          # http://localhost:3002

# In a second terminal, start the web UI
bun run dev:web             # http://localhost:5173
```

Open http://localhost:5173, create a board, paste a PRD, and click **▶ Run** on any task.

---

## CLI

```bash
# Start server + open browser
bun cli init

# Watch a task execute with live output
bun cli start <taskId>

# Show all boards and task counts
bun cli status
```

---

## Board MCP server

Expose the board as tools so Claude Code can manage tasks programmatically:

```bash
bun mcp:board
```

Or add to `.mcp.json` for Claude Code to use:

```json
{
  "mcpServers": {
    "agent-trail-board": {
      "command": "bun",
      "args": ["packages/core/src/mcp/board-server.ts"],
      "env": {
        "AGENT_TRAIL_DB_PATH": "/absolute/path/to/agent-trail.db"
      }
    }
  }
}
```

**Available tools:** `list_tasks`, `get_task`, `update_task_status`, `add_task`

---

## TDD gate

Enable the TDD gate on any task to enforce a 3-phase lifecycle:

```
write_tests   → Claude writes failing tests only
implement     → Claude writes code to make tests pass
verify_tests  → test runner executes directly (no Claude); exit 0 → in_review
```

Supported runners: bun (default), jest, vitest, pytest (auto-detected from `package.json` + config files).

---

## How it works

1. **Planner** calls `claude-sonnet-4-6` with a `create_task_graph` tool, returning a validated DAG of tasks with priorities and dependencies
2. **Execution manager** spawns `claude -p <prompt> --output-format stream-json --verbose` per task in a git worktree, with a phase-specific system prompt appended
3. **SSE bus** broadcasts `tool_call`, `text`, `test_result`, and `awaiting_human` events to all subscribers in real time
4. **ask_human MCP** — when Claude calls `ask_human(question)`, the server writes a `decision_tickets` row, the UI shows an amber decision card, and execution resumes once the user answers
5. **Post-execution** captures `git diff HEAD` and `git status --porcelain` as artifacts, visible in the task detail panel

---

## Development

```bash
bun test                    # run all tests (12 planner + DAG tests)
bun probe:claude            # de-risk stream-json parser against live claude CLI
bun run dev:server          # hot-reload API server
bun run dev:web             # Vite HMR web UI
```

---

## Contributing

PRs welcome. The 7-day build log is in `docs/` — each day's completion log documents what was built and why.

Planned for v0.2: Codex/Gemini adapters, VS Code extension, multi-board views.

---

## License

MIT
