# Day 4 — Completion log

**Date:** 2026-05-22  
**Status:** Complete

---

## What was built

### Core adapters (`packages/core/src/adapters/`)
- `worktree.ts` — `WorktreeManager`: `create(taskId)` → `git worktree add --detach .worktrees/<taskId> HEAD`, `remove(taskId)`. Degrades gracefully if not in a git repo (returns null, execution runs in repo root).
- `mcp-config.ts` — `McpConfigManager`: reads `.mcp.json` or `.claude/settings.json`, filters to `task.mcps` list, writes temp file to `os.tmpdir()`. Returns null if no matching servers found.
- `claude-code.ts` — `spawnClaudeCode()`: spawns `claude -p <prompt> --output-format stream-json --verbose --no-session-persistence --permission-mode bypassPermissions --append-system-prompt <phase-prompt>`. Reads stdout line-by-line via `readline`. Guards against calling `onError` after `onComplete`.

### Telemetry (`packages/core/src/telemetry/`)
- `parser.ts` — `parseTelemetry(event, raw)` → `ParsedTelemetry | null`. Maps stream events to `TelemetryEventKind`. `extractMetrics(result)` pulls duration/tokens from `result` event.

### Server
- `src/execution-manager.ts` — singleton `ExecutionManager`. Enforces MAX_CONCURRENT=3. Manages SSE subscribers per task via `ReadableStream`. Stores telemetry events to DB, broadcasts UI events to all subscribers, finalizes execution on complete/error.
- `src/routes/executions.ts` — `POST /api/tasks/:taskId/execute`, `GET /api/tasks/:taskId/stream` (SSE), `GET /api/executions/:id/telemetry`, `GET /api/tasks/:taskId/executions`

### Frontend
- `TaskDetail`: Run button (▶ Run), running indicator, live activity feed (tool calls, text output, completion status) via `EventSource`
- `TaskCard`: pulsing green dot when `status === "in_progress"`
- `api.ts`: `streamTaskEvents()` helper, `api.tasks.execute()`

---

## Key design decisions

- **`--append-system-prompt`** rather than `--system-prompt` — preserves Claude Code's default system prompt (CLAUDE.md, tools context) and appends TDD phase instructions
- **Worktrees are not auto-cleaned** after execution — user may want to inspect. Manual cleanup or future task-delete hook
- **SSE via raw ReadableStream** in Hono — no library needed, controller stored per-subscriber, cleaned up on `cancel()`
- **`onError` guard** — `resultReceived` flag prevents false error after normal exit (claude exits 0 after emitting `result`)

---

## Day 5 plan

**Goal:** Three-phase TDD gate + `ask_human` MCP tool + UI for decision tickets

### Files to create

1. `packages/core/src/adapters/test-runner.ts` — detect and run test suite (`bun test`, `jest`, `pytest`). Used for `verify_tests` phase — no Claude spawn, just run tests and check exit code.
2. `packages/core/src/mcp/ask-human.ts` — MCP server tool: `ask_human(question, context)` → writes to `decision_tickets`, returns sentinel to pause agent
3. `packages/server/src/routes/decisions.ts` — `GET /api/tasks/:taskId/decisions` (list open tickets), `POST /api/decisions/:id/answer`
4. Update `execution-manager.ts` to handle `awaiting_human` state: pause SSE, surface ticket
5. `packages/web/src/components/DecisionTicket.tsx` — UI card for answering `ask_human` questions, appears on the blocked task card
6. Update `Board.tsx` / `TaskCard.tsx` to surface decision tickets inline

### TDD gate automation
When `tddPhase === "verify_tests"`: skip Claude, run test runner, read exit code.
- Exit 0 → finalize `completed`, advance task to `in_review`
- Exit non-0 → finalize `failed` with test output, keep task `blocked`
