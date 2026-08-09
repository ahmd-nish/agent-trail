# Changelog

All notable changes to inventarium will land here. Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/).

## [Unreleased]

### Added — Phase 5 loop engineering (§5.2, §5.5, §5.6)
- **§5.2 Ralph iteration memory** — migration v21 adds `iteration_memories` table. Every verify_tests failure writes a compact "what was tried and why it failed" row (typed-exception-prioritised error headline, files-changed count, "don't repeat the same fix" warning). At the next spawn, the L1 pack renders `=== Prior iterations (Ralph memory) ===` with the last 3 iterations chronologically so a fresh-context re-spawn doesn't repeat the same losing fix.
- **§5.5 Loop observability** — `GET /api/boards/:id/loop-metrics` returns per-task counters (iterations recorded, verify runs+failures, thrash tickets, tokens, time-to-first-green) plus board aggregates (median time-to-green, escalated-to-opus count, total thrash tickets, total iterations). Powers the UI "loop 2/5, $0.12" chip and any CI-side escalation-rate alerts.
- **§5.6 Deploy agent (human-gated)** — migrations v22 add `deploy_targets` + `deploys` tables. `packages/core/src/adapters/deploy.ts` `runDeploy(target, opts)` runs the shell command with a 10-min timeout + 200KB output cap, polls the healthcheck URL 6× at 3s intervals, auto-runs `rollback_command` on healthcheck-fail or command-fail. HTTP: `GET/POST /api/boards/:id/deploy-targets`, `POST /api/boards/:id/deploy` (raises a decision ticket by default; `autoConfirm: true` skips for CI), `POST /api/deploys/:id/confirm` (one-shot; 409 if not pending), `GET /api/deploys/:id`. CLI: `inventarium deploy --board <id> --target <name> [--yes] [--auto-confirm] [--timeout <sec>]`, exit 0 on success, 1 on failure, 124 on timeout.

### Added — Phase 4 intelligence layer (§4.1, §4.2, §4.3, §4.4, §4.4b, §4.7)
- **§4.1/§4.2 Team agent library** — `.inventarium/library/agents/<name>.md` is the git-tracked home for team subagents. `inventarium library add <url>` imports an agentskills.io-style markdown file (frontmatter + body, sha256 checksum, source URL). `inventarium library new <name>` scaffolds a stub. `inventarium library ls|rm` for management. API: `GET /api/library`, `POST /api/library` (from `{markdown}` or `{name, description}`), `POST /api/library/import` (fetch a URL), `DELETE /api/library/:name`.
- **§4.3 Planner auto-matching** — the planner prompt now receives every library entry's name+description; it populates `subagents[]` per task from the offered names. Hallucinated names filtered out at coerce time when the library isn't empty.
- **§4.4 Repo map + MCP retrieval tools** — new `packages/core/src/context/repo-map.ts` ranks `git ls-files` by term overlap with the task text (title+description+criteria) and injects the top-8 paths into the L1 pack as a "Likely relevant files" section. The `inventarium` MCP server now exposes two just-in-time retrieval tools alongside `ask_human`: `get_task_memory(taskId)` and `list_task_memories()` so a running agent can pull a dependency's compact summary without the human having to prompt for it.
- **§4.4b Steering queue** — migration v19 adds `steering` table. `POST /api/tasks/:id/steer { text, kind? }` drops guidance without interrupting the current iteration; at the next spawn the execution manager pulls pending steers, marks them consumed, and renders them as a "New guidance from the user" section in the L1 pack. `GET /api/tasks/:id/steer[?includeConsumed=1]` for inspection, `DELETE /api/steering/:id` to cancel a pending one.
- **§4.7 File-footprint parallelism** — migration v20 adds `tasks.likely_paths` (JSON array); planner emits per task ("`likelyPaths: ["src/routes/notes.ts", "src/db/schema.sql"]`"). `hasOverlap()` treats exact matches and directory-prefix relationships as conflicts (but two files under the same dir are NOT auto-conflicting — that trade-off keeps most tasks parallelisable). Board runner picks the next-runnable task whose footprint doesn't overlap any active task's — no-op today because the loop is already serial, but the primitive is in place for the parallel picker.

### Added — Loop engineering (§5.1, §5.3, §5.4) + cost dashboard (§4.6)
- **§4.6 token/cost dashboard** — `GET /api/boards/:id/cost` returns per-tier breakdown (input tokens, output tokens, executions, USD), totals, and a "naive baseline" delta (what the same volume would have cost on all Sonnet). Public pricing table pinned in `packages/core/src/planner/pricing.ts`.
- **§5.3 thrash detection** — two verify_tests failures with the same normalized error, or two consecutive implement runs producing zero file changes, short-circuit blind escalation and instead raise a decision ticket with the pattern history. Path/line-number/duration/pid normalization so real test output that differs only cosmetically is still recognized as identical.
- **§5.1 Task.loopPolicy** — formal knobs for the existing TDD gate + router-v2 escalation + thrash detection. Nullable per-task JSON column (`tasks.loop_policy`, migration v18); `resolveLoopPolicy(tddEnabled, partial)` merges over sensible defaults. `PATCH /api/tasks/:id` accepts `loopPolicy`.
- **§5.4 board loop CLI** — `inventarium loop --board <id> [--budget $N] [--timeout <sec>]` walks the DAG until every task is terminal, an open decision ticket appears (exit 2), the budget crosses (exit 3), or the timeout hits (exit 124). "Ralph the backlog" from the launch materials.

### Added — Idea → Guided plan → Test → Build wizard
- **Idea wizard backend (§A1)** — new `ideas` table (migration v16) + `POST /api/ideas/start`, `POST /api/ideas/:id/answer`, `POST /api/ideas/:id/synthesize-prd`, `POST /api/ideas/:id/link-board`. First call to Sonnet generates 4 tailored dimension questions (frontend / backend / database / packages) each with 3-4 options + pros/cons; second call synthesizes a full markdown PRD. `INVENTARIUM_IDEA_MOCK` env for tests.
- **Idea wizard UI (§A2)** — `IdeaWizard` component + `EmptyBoardState` promoted "Start from an idea" to the primary CTA. Multi-step form with tappable option cards showing pros/cons per pick, per-question "other" text input, review-before-synthesize, and a preview of the generated PRD before the planner runs.
- **Test-case categories (§B)** — new `TestCase.category` field (`happy | edge | negative | error | boundary | perf`). Planner + case-generator prompts now require ≥1 happy + ≥1 negative per criterion. `GET /api/tests/:taskId/coverage` returns a per-criterion audit (`meetsBar`, `missing`, per-category counts). Missing categories default to `happy` for backward compat.
- **Plan-review + approval gate (§C)** — migration v17 adds `boards.approved_at`. Planner-created boards land pending; `POST /api/tasks/:id/execute`, `/resume`, and `/boards/:id/run` all return 403 until `POST /api/boards/:id/approve` fires. Manual `POST /api/boards` auto-approves so existing flows aren't disrupted. UI: `PlanReviewBanner` above the board with the pending plan, coverage warnings, and a one-click "Approve & Start Building".
- **Context orchestrator (§D)** — per-task L1 pack replaces the "dump the constitution into every prompt" approach. After each terminal success, a heuristic memory (~1KB, files touched + decisions raised + criteria met) lands in `.inventarium/context/memories/<taskId>.md`. Downstream DAG tasks get those summaries prepended to their system prompt as `## Task pack (L1)` — strategic context per task, cap 4000 chars. E2E proves a downstream task sees its dependency's memory in the echoed system prompt.

### Added — Phase 4 intelligence layer (§4.5)
- **Model router v2 — auto-escalation on failed verify loops** — after 2 consecutive `verify_tests` failures on a TDD-enabled task, the router bumps the tier one step (haiku → sonnet → opus), resets the failure counter, drops the phase back to `implement`, and auto-restarts. Broadcasts a `[router-v2] tier escalated <from> → <to>` feed event so the animation layer (Arcade OPUS-MODE aura) can react. Opus tasks stay at opus — no infinite escalation, they land `blocked` for a human.
- New `nextTier()` helper in `packages/core/src/planner/models.ts`.
- Migration v15: `tasks.failed_verify_count`.

### Added — Phase 3 team-context layer (§3.1, §3.2, §3.3, §3.4, §3.5)
- **`.inventarium/state.json` bidirectional sync (§3.1, §3.5)** — the board + task graph now serializes to a single merge-friendly JSON at the project root. On server boot, if `state.json` exists it hydrates the DB (`updated_at` acts as a per-row merge tiebreaker); auto-sync writes changes back to disk every 2 s (dirty-checked via content hash). Teammates clone the repo → `npx inventarium` → same board, same tasks, no setup.
- **`inventarium sync export|import|status`** — CLI for one-shot serialization.
- Set `INVENTARIUM_SKIP_AUTOSYNC=1` to disable the auto-writer (used by tests + read-only setups).
- **Team-context store** — `.inventarium/context/` is now the durable home for team rulings, conventions, and architectural decisions. New helper module `packages/core/src/context/store.ts` handles read/write.
- **`inventarium context add "<text>" [--file <name>]`** — CLI subcommand appends a note to `.inventarium/context/notes.md` (or a named file). `inventarium context ls` lists context files with sizes and first lines.
- **Decision persistence** — every answered `ask_human` ticket auto-appends a formatted entry (date, task title, question, answer, author) to `.inventarium/context/decisions.md`. Author auto-detected via `git config user.name` → hostname → `local`.
- **L0 constitution injection** — CLAUDE.md at the project root plus every markdown file in `.inventarium/context/` is loaded per-execution and prepended to the system prompt with source headers, capped at ~8K chars (~2K tokens). Placed after the TDD phase instructions so phase discipline stays authoritative.
- **`buildSystemPrompt` extracted** to `packages/core/src/adapters/system-prompt.ts` for standalone testability.

### Added
- **`npx inventarium` one-command install** — the server now serves the built web SPA directly, so a fresh clone (or fresh npm install) opens the board with a single command. Port auto-fallback when 3002 is busy.
- **`inventarium doctor`** — preflight checks for Bun, git, claude CLI, API key, port availability, and CWD writability, with friendly fix-it hints.
- **Sample PRD + "Plan this" button** — empty-board state now offers a one-click plan from a bundled URL-shortener PRD; Notes API and other examples appear as chips.
- **Demo replay mode** — `npx inventarium --demo` runs a scripted execution through the real SSE pipeline with no API key, no claude CLI, and zero cost. Interactive decision ticket pauses the replay; end-of-run credits card CTAs installation.
- **Static model router** — every task now has a `modelTier` (haiku/sonnet/opus). Planner suggests a tier (docs → haiku, code/tests → sonnet); UI dropdown lets you override per-card. Concrete Claude model name pinned in `packages/core/src/planner/models.ts` (bump the version there for a model update).
- **DAG view** — reactflow-based dependency graph, restored and retuned to the CLAW theme. Clickable nodes open the task detail; edges into `in_progress` tasks animate.
- **Engagement beats** — cost odometer in the titlebar; red→green test-result flash + done-pulse on task cards; all new animations honor `prefers-reduced-motion`.
- **6 bundled subagents** — tdd-implementer, test-writer, frontend-implementer, api-implementer, db-migrator, refactorer. Discoverable via `/api/agents`; project `.claude/agents/` overrides bundled by name. Task-detail picker chips let you toggle per task.
- **Crash recovery** — orphan `running` executions from a killed server are flipped to `failed` on next boot, and their tasks moved from `in_progress` to `blocked` with a clear retry hint. No more stuck cards after a crash.
- **TDD gate auto-advance** — a `tddEnabled` task now rolls through `write_tests → implement → verify_tests` automatically. Only `verify_tests` failing lands the task in `blocked` (cannot close with failing tests).
- **Test-only env hooks** — `INVENTARIUM_PLANNER_MOCK` and `INVENTARIUM_CLAUDE_MOCK` let end-to-end tests drive the full server pipeline without a real claude CLI or API key. Enables `bun test` on machines with neither.
- **Extensive E2E test coverage** — 214 tests across 22 files cover static hosting, planner + DAG, board CRUD, execution engine, TDD gate, ask_human tickets, artifacts, subagent discovery, demo fixture, and crash recovery.

### Fixed
- v1-bug-5 (crash recovery): see above.
- v1-bug-3 (misleading `ANTHROPIC_API_KEY` prerequisite): the doctor now warns rather than fails when the key is missing, matching the fact that `claude` CLI auths via `claude login`, not the env var.

### Changed
- `resolveProjectRoot()` (new export from `packages/core/src/storage/paths.ts`) governs where the DB, `.worktrees/`, and `.mcp.json` live. Defaults to CWD; override with `INVENTARIUM_ROOT`. Fixes worktrees landing inside `node_modules/` when installed via `npx`.
- `INVENTARIUM_PORT` env var replaces hardcoded 3002.
- `INVENTARIUM_SKIP_RUNNER=1` lets tests + minimal installs skip the dev-server runner spawn.

## [0.2.0] — 2026-05-27

Rename: `vibe-board` → `inventarium`. Legacy `AGENT_TRAIL_*` env vars remain as fallbacks for one release.

## [0.1.0] — 2026-05-23

Initial MVP: PRD → planner → DAG → kanban → claude execution in a worktree → SSE telemetry → SQLite → ask_human MCP → git-diff artifacts.
