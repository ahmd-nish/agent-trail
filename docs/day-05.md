# Day 5 — Completion log

**Date:** 2026-05-22  
**Status:** Complete

---

## What was built

### Test runner (`packages/core/src/adapters/test-runner.ts`)
- `detectRunner(cwd)` — checks `package.json` scripts/devDeps for jest/vitest, falls back to `bun test`
- Also detects Python projects via `pytest.ini` / `conftest.py` / `pyproject.toml`
- `runTests(cwd): Promise<TestRunResult>` — spawns test command, collects stdout+stderr, returns `{passed, exitCode, output, durationMs}`

### `ask_human` MCP server (`packages/core/src/mcp/ask-human.ts`)
- MCP server built with `@modelcontextprotocol/sdk`
- Exposes single tool: `ask_human(question, context?)`
- Writes row to `decision_tickets` table (DB path via `AGENT_TRAIL_DB_PATH` env var)
- Returns `PAUSE_EXECUTION:<ticketId>` sentinel + instruction to output `AWAITING_HUMAN`
- Spawned per-task via `--mcp-config` injection (always present, not optional)

### MCP config manager (updated)
- `write(taskId, requestedMcps, askHumanOpts)` — always includes `agent-trail` (ask_human) MCP
- Merges task-specific MCPs from `.mcp.json` on top
- Returns path to temp JSON file (required, not nullable — ask_human is always present)

### Execution manager (updated)
- `verify_tests` phase: runs `test-runner.ts` directly, no Claude spawn
  - Stores test output as `artifacts` row (kind: `test_output`)
  - Exit 0 → task moves to `in_review`; exit non-0 → task moves to `blocked`
- `resume(taskId, question, answer)` — creates new execution with decision context appended to description
- `AWAITING_HUMAN` detection: checks `result.result` for sentinel, transitions execution to `awaiting_human`, task to `blocked`
- Always injects `ask_human` MCP config (DB path + task/execution IDs via env)

### Decision routes (`packages/server/src/routes/decisions.ts`)
- `GET /api/tasks/:taskId/decisions` — list all tickets for a task
- `POST /api/decisions/:ticketId/answer` — record answer + call `executionManager.resume()`

### Frontend
- `DecisionTicket.tsx` — amber-highlighted card with question, context, answer input, submit button
- `TaskDetail.tsx` — loads open tickets on mount when task is `blocked`, shows tickets above activity feed, streams resumed execution after answer
- `TaskCard.tsx` — amber pulsing dot for blocked tasks with `activeForm` set (signals pending decision)
- `api.ts` — `api.tasks.decisions()`, `api.decisions.answer()`, `UiEvent` extended with `awaiting_human` and `test_result`

---

## TDD gate flow (end-to-end)

```
write_tests → [Claude writes failing tests]
    ↓ task advances to implement phase manually or via UI
implement  → [Claude implements code]
    ↓
verify_tests → [test-runner runs bun test / jest / pytest]
    exit 0  → task moves to in_review ✓
    exit ≠0 → task moves to blocked, test output stored as artifact
```

## ask_human flow

```
Agent calls ask_human("question") 
  → MCP writes decision_tickets row
  → MCP returns PAUSE_EXECUTION:<id>
  → Claude outputs AWAITING_HUMAN
  → result event fires, execution-manager detects sentinel
  → execution → awaiting_human, task → blocked
  → UI shows DecisionTicket card on open panel
  → User types answer, clicks Answer
  → POST /api/decisions/:id/answer
  → executionManager.resume() spawns new execution with answer in context
  → Claude continues with the answer
```

---

## Day 6 plan

**Goal:** Post-execution hooks (diff, file list), MCP server exposing the board to Claude Code itself, JSON export

### Files to create

1. `packages/core/src/adapters/post-execution.ts` — after execution completes: `git diff HEAD`, list modified files, capture test output → write to `artifacts` table
2. `packages/core/src/mcp/board-server.ts` — MCP server exposing the board as tools: `list_tasks`, `get_task`, `update_task_status`, `add_task`. Lets Claude Code manage the board programmatically.
3. `packages/server/src/routes/artifacts.ts` — `GET /api/tasks/:taskId/artifacts`, `GET /api/artifacts/:id`
4. `packages/server/src/routes/export.ts` — `GET /api/boards/:boardId/export` returns full board as JSON
5. Update `TaskDetail.tsx` to show artifacts (git diff viewer, test output)
6. Update `package.json` to expose a `mcp:board` script that starts the board MCP server
