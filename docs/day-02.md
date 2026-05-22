# Day 2 — Completion log

**Date:** 2026-05-22  
**Status:** Complete

---

## What was built

- `packages/core/src/planner/dag.ts` — DAG resolver
  - Kahn's topological sort
  - Level-based parallel group assignment: tasks at the same level get the same `parallelGroup` UUID
  - Throws on cycles and unknown `dependsOn` references

- `packages/core/src/planner/index.ts` — `planFromPrd(prdText, boardId): Promise<PlanResult>`
  - Anthropic SDK, model `claude-sonnet-4-6`
  - Tool-use structured output via `create_task_graph` tool
  - `tool_choice: {type: "tool", name: "create_task_graph"}` forces the call
  - Repair loop: up to 2 retries on validation failure
  - Validates: non-empty array, unique IDs, no unknown `dependsOn` refs
  - Passes output through `buildDag` to return topologically ordered tasks

- `packages/core/src/planner/planner.test.ts` — 12 tests, all green
  - DAG tests: linear chain, parallel groups, sequential groups, cycle detection, unknown ref, empty list, solo task
  - Planner tests: required fields, dependsOn validity, topological order, API call count, retry-on-failure (3 calls on 3 bad responses)
  - Anthropic SDK stubbed via `mock.module("@anthropic-ai/sdk", ...)`

## Key decisions

- **Tool-use** (not JSON mode): `tool_choice: {type: "tool", name: "create_task_graph"}` is the most reliable way to get structured output
- **Parallel group = level**: all tasks with in-degree 0 at the same Kahn's iteration round share a group. This is conservative (some tasks in the same level might have resource conflicts) but correct for the MVP.
- **`tddPhase` coercion**: planner sets `write_tests` if `tddEnabled`, `implement_only` otherwise — the executor picks this up at spawn time

---

## Day 3 plan

**Goal:** Board UI — React app, 6-column kanban, task detail panel, DAG viz

### Files to create

1. `packages/web/src/main.tsx` — React entry point
2. `packages/web/src/App.tsx` — root, wraps board
3. `packages/web/src/components/Board.tsx` — 6-column kanban (`backlog → ready → in_progress → blocked → in_review → done`)
4. `packages/web/src/components/TaskCard.tsx` — card with status badge, priority, assignee, MCP chips
5. `packages/web/src/components/TaskDetail.tsx` — side panel: full description, MCP/skill assignment, TDD toggle, DAG parents/children
6. `packages/web/src/components/DagView.tsx` — react-flow DAG visualization
7. `packages/web/src/lib/api.ts` — typed fetch wrappers for the server API (stubs until Day 4 server is live)
8. `packages/web/vite.config.ts` + `tailwind.config.ts` + `postcss.config.ts` — build config
9. `packages/server/src/index.ts` — minimal Hono server with board/task CRUD routes + SQLite init

### Decisions to make on Day 3

- shadcn/ui component set: install the ones we need (Card, Badge, Sheet, Dialog, Tabs)
- react-flow vs custom SVG for DAG view: react-flow (lower friction for MVP)
- Server port: 3001 (3000 often taken)
