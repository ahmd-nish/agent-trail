# Day 3 — Completion log

**Date:** 2026-05-22  
**Status:** Complete

---

## What was built

### Server (`packages/server`)
- `src/db.ts` — SQLite init from `schema.sql` (WAL mode, runs on first `getDb()` call), row-to-type mappers
- `src/routes/boards.ts` — `GET/POST /api/boards`, `DELETE /api/boards/:boardId`
- `src/routes/tasks.ts` — `GET /api/boards/:boardId/tasks`, `POST /api/boards/:boardId/tasks`, `PATCH /api/tasks/:taskId`, `DELETE /api/tasks/:taskId`, SSE stub at `GET /api/tasks/:taskId/stream`
- `src/index.ts` — Hono server on **port 3002** (3001 taken by Classifi dev server), CORS for localhost:5173/5174

### Web (`packages/web`)
- Vite 8 + React 19 + Tailwind v4 + @tailwindcss/vite
- `src/lib/api.ts` — typed fetch client wrapping all server endpoints
- `src/components/Board.tsx` — 6-column kanban with @dnd-kit drag-and-drop between status columns
- `src/components/TaskCard.tsx` — card with priority badge, TDD tag, MCP chips
- `src/components/TaskDetail.tsx` — slide-in right panel: edit title/desc, status/priority/assignee dropdowns, TDD toggle, MCP add/remove, dependsOn display
- `src/components/DagView.tsx` — react-flow visualization, nodes positioned by dependency depth, animated edges for in-progress tasks
- `src/App.tsx` — board selector, new board creation, kanban/DAG view switcher, state management

### Build
- Clean Vite production build: 187 modules, 342kB JS, 22kB CSS

## Technical notes
- Tailwind v4: uses `@import "tailwindcss"` in CSS + `@tailwindcss/vite` Vite plugin (no config file)
- React 19 installed (bun resolved ^18.3 → 19.2.6) — works fine with @vitejs/plugin-react v6
- SQLite DB created at `inventarium.db` in the CWD when the server starts
- `task.dependsOn` stored as JSON string in SQLite; mapper parses on read

---

## Day 4 plan

**Goal:** Worktree manager, scoped MCP config injection, Claude Code adapter, stream-json parser, SSE to frontend

### Files to create

1. `packages/core/src/adapters/claude-code.ts` — `ClaudeCodeAdapter`: spawns `claude -p ... --output-format stream-json --verbose --no-session-persistence`, reads events from the probe-locked `StreamEvent` types
2. `packages/core/src/adapters/worktree.ts` — `WorktreeManager`: `create(taskId)` → `git worktree add`, `remove(taskId)`
3. `packages/core/src/adapters/mcp-config.ts` — writes a temp `mcp_config_<taskId>.json` with the task's MCP list
4. `packages/core/src/telemetry/parser.ts` — parses `StreamEvent` lines into `TelemetryEvent` rows + updates `Execution`
5. `packages/server/src/routes/executions.ts` — `POST /api/tasks/:taskId/execute` (spawn adapter), `GET /api/tasks/:taskId/stream` (real SSE, replaces stub)
6. Update `Board.tsx` / `TaskCard.tsx` to show live activity from SSE

### Key constraints
- Worktree path: `<repo-root>/.worktrees/<taskId>`
- MCP config temp path: `<os.tmpdir()>/inventarium-mcp-<taskId>.json`
- Max 3 concurrent executions (enforced in dispatcher)
- Stream-json parser must handle multiple `assistant` events with the same `message.id`
