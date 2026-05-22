# Day 1 — Completion log

**Date:** 2026-05-21  
**Status:** Complete (files recreated in new session from handoff doc)

---

## What was built

- Root monorepo scaffold: `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `LICENSE` (MIT)
- Directory structure: `packages/{core,cli,server,mcp-server,web}`, `scripts/`, `docs/`, `examples/`
- Sub-package `package.json` files for all five packages
- `packages/core/src/types/index.ts` — complete domain types: `Task`, `Board`, `Execution`, `Artifact`, `TelemetryEvent`, `DecisionTicket`, all enums
- `packages/core/src/storage/schema.sql` — full SQLite schema, WAL mode, foreign keys, all indexes
- `packages/core/src/index.ts` — re-exports
- `scripts/probe-claude-code.ts` — four-scenario probe for `claude --output-format stream-json`
- `examples/sample-prd.md` — URL shortener PRD for Day 7 dogfood

## Key decisions made

- Stack locked: Bun + TypeScript + Hono + SQLite + React 18 + shadcn/ui
- Execution split: Anthropic API = planner, Claude Code headless = executor
- Per-task git worktrees + scoped `--mcp-config` for MCP isolation
- TDD gate: `write_tests → implement → verify_tests` default; `implement_only` for non-code tasks
- Human decision flow via `ask_human` MCP tool + `decision_tickets` table
- MVP parallelism cap: 3 concurrent tasks

## What's NOT done yet

- Probe has not been run. **Run it before Day 4.**
- Days 2–7 implementation

---

## Day 2 plan

**Goal:** Anthropic SDK planner — PRD → `Task[]` with DAG resolution

### Files to create

1. `packages/core/src/planner/index.ts` — `planFromPrd(prdText: string): Promise<Task[]>`
   - Uses `@anthropic-ai/sdk` tool-use structured output
   - Tool: `create_task_graph` with JSON schema matching `Task[]`
   - Repair loop: up to 2 retries on schema validation failure
   - Model: `claude-sonnet-4-6`

2. `packages/core/src/planner/dag.ts` — DAG resolver
   - Topological sort of `Task.dependsOn`
   - Parallel group detection: tasks with no shared dependencies → same `parallelGroup`
   - Returns `{ ordered: Task[], parallelGroups: Map<string, Task[]> }`

3. `packages/core/src/planner/index.test.ts` — tests
   - Fixture: `examples/sample-prd.md` stubbed into planner
   - Stub the Anthropic SDK (`bun:mock`)
   - Assert: all tasks have IDs, `dependsOn` references are valid, no cycles

### Decisions to make on Day 2

- Confirm model: `claude-sonnet-4-6` (default) vs `claude-opus-4-7` for planner
- Confirm structured output strategy: tool-use (preferred) vs JSON schema
- Planner repair-loop budget: 2 retries (proposed)

### Order of work

1. Write the test file first (TDD)
2. Write `dag.ts` (pure, easy to test)
3. Write `planner/index.ts` (hits the API — stub in tests)
4. Run `bun test packages/core` — all green before moving on
