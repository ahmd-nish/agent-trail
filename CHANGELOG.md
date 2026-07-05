# Changelog

All notable changes to agent-trail will land here. Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/).

## [Unreleased]

### Added
- **`npx agent-trail` one-command install** — the server now serves the built web SPA directly, so a fresh clone (or fresh npm install) opens the board with a single command. Port auto-fallback when 3002 is busy.
- **`agent-trail doctor`** — preflight checks for Bun, git, claude CLI, API key, port availability, and CWD writability, with friendly fix-it hints.
- **Sample PRD + "Plan this" button** — empty-board state now offers a one-click plan from a bundled URL-shortener PRD; Notes API and other examples appear as chips.
- **Demo replay mode** — `npx agent-trail --demo` runs a scripted execution through the real SSE pipeline with no API key, no claude CLI, and zero cost. Interactive decision ticket pauses the replay; end-of-run credits card CTAs installation.
- **Static model router** — every task now has a `modelTier` (haiku/sonnet/opus). Planner suggests a tier (docs → haiku, code/tests → sonnet); UI dropdown lets you override per-card. Concrete Claude model name pinned in `packages/core/src/planner/models.ts` (bump the version there for a model update).
- **DAG view** — reactflow-based dependency graph, restored and retuned to the CLAW theme. Clickable nodes open the task detail; edges into `in_progress` tasks animate.
- **Engagement beats** — cost odometer in the titlebar; red→green test-result flash + done-pulse on task cards; all new animations honor `prefers-reduced-motion`.
- **6 bundled subagents** — tdd-implementer, test-writer, frontend-implementer, api-implementer, db-migrator, refactorer. Discoverable via `/api/agents`; project `.claude/agents/` overrides bundled by name. Task-detail picker chips let you toggle per task.
- **Crash recovery** — orphan `running` executions from a killed server are flipped to `failed` on next boot, and their tasks moved from `in_progress` to `blocked` with a clear retry hint. No more stuck cards after a crash.
- **TDD gate auto-advance** — a `tddEnabled` task now rolls through `write_tests → implement → verify_tests` automatically. Only `verify_tests` failing lands the task in `blocked` (cannot close with failing tests).
- **Test-only env hooks** — `AGENT_TRAIL_PLANNER_MOCK` and `AGENT_TRAIL_CLAUDE_MOCK` let end-to-end tests drive the full server pipeline without a real claude CLI or API key. Enables `bun test` on machines with neither.
- **Extensive E2E test coverage** — 214 tests across 22 files cover static hosting, planner + DAG, board CRUD, execution engine, TDD gate, ask_human tickets, artifacts, subagent discovery, demo fixture, and crash recovery.

### Fixed
- v1-bug-5 (crash recovery): see above.
- v1-bug-3 (misleading `ANTHROPIC_API_KEY` prerequisite): the doctor now warns rather than fails when the key is missing, matching the fact that `claude` CLI auths via `claude login`, not the env var.

### Changed
- `resolveProjectRoot()` (new export from `packages/core/src/storage/paths.ts`) governs where the DB, `.worktrees/`, and `.mcp.json` live. Defaults to CWD; override with `AGENT_TRAIL_ROOT`. Fixes worktrees landing inside `node_modules/` when installed via `npx`.
- `AGENT_TRAIL_PORT` env var replaces hardcoded 3002.
- `AGENT_TRAIL_SKIP_RUNNER=1` lets tests + minimal installs skip the dev-server runner spawn.

## [0.2.0] — 2026-05-27

Rename: `vibe-board` → `agent-trail`. Legacy `VIBE_BOARD_*` env vars remain as fallbacks for one release.

## [0.1.0] — 2026-05-23

Initial MVP: PRD → planner → DAG → kanban → claude execution in a worktree → SSE telemetry → SQLite → ask_human MCP → git-diff artifacts.
