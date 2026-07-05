# Contributing to agent-trail

Thanks for wanting to help. agent-trail is a small, focused kanban orchestrator for AI coding agents — the codebase reflects that. Bugs, adapters, subagents, and docs are all welcome.

## Quickstart

```bash
git clone https://github.com/anthropics/agent-trail
cd agent-trail
bun install
bun run -F @agent-trail/web build
bun test
```

To try the app end-to-end locally:

```bash
bun packages/cli/src/index.ts
```

To try the demo replay (no API key needed):

```bash
bun packages/cli/src/index.ts --demo
```

## Ground rules

- **Tests pass before you push.** `bun test` is the source of truth. If a test fails on your machine, the fix goes with the change.
- **Prefer editing existing files.** New files earn their keep — they're not a status symbol.
- **No emoji in code, comments, or commit messages.** They rot when the terminal changes.
- **One PR, one concern.** A refactor and a feature belong in two PRs.
- **Match the surrounding style.** Biome runs in the repo; the style is already decided.

## Where to look

- **`packages/core/`** — planner, adapters (claude-code, test-runner, worktree, mcp-config), telemetry parser, types. No HTTP, no React.
- **`packages/server/`** — Hono routes, execution manager, DB migrations. All HTTP is here.
- **`packages/web/`** — React + Vite + Tailwind. Kanban board, DAG view, task detail, cinematic feed.
- **`packages/cli/`** — the `agent-trail` binary + `agent-trail doctor`. Bundled examples + subagents ship here.
- **`packages/runner/`** — long-running dev-server manager (separate process on :3003).

## Adding a bundled subagent

Drop a markdown file at `packages/cli/agents/<name>.md` with YAML frontmatter:

```markdown
---
name: my-agent
description: One sentence — when to use this agent.
tools: Read, Edit, Write, Bash
---

The prompt / instructions the subagent runs with.
```

The `/api/agents` route auto-discovers it (project `.claude/agents/` overrides bundled by name).

## Adding an adapter for another agent CLI

**30-minute checklist** (Phase 2.4):

1. Copy `packages/core/src/adapters/codex.ts` — it's a working skeleton.
2. Rename `spawnCodex` → `spawnFoo`, swap the binary check + flag names.
3. At the bottom of the file: `registerAdapter("foo", spawnFoo);` — the exec manager dispatches on `Task.assignee`.
4. Add a scenario mock env hook (see `runMockAdapter` in `claude-code.ts`) so E2E tests can drive it without the real CLI.
5. Write one E2E test following `packages/server/src/execution-e2e.test.ts`.

Contract you must uphold:

- Emit `StreamEvent`s (see `packages/core/src/types/stream-json.ts`) via `callbacks.onEvent(raw, parsed)` — the beat compiler + telemetry + UI all consume this shape unchanged.
- Emit exactly one `result` event via `callbacks.onComplete(result)` at end.
- If you can, populate `result.session_id` — PRD 2.2 uses it to `--resume` on crash.
- Respect `permissionMode` (default `acceptEdits`) and `timeoutMs`.

## Writing tests

We prefer E2E tests that spin the real server and hit real HTTP endpoints. See `packages/server/src/execution-e2e.test.ts` for the pattern (spawn server, poll `/api/health`, drive endpoints, kill). Unit tests are welcome for pure functions.

## Reporting bugs

Include:
1. What you did (exact commands, exact URL)
2. What you expected
3. What you saw (stack trace, screenshot, both)
4. `bun --version`, `git rev-parse HEAD`, OS

## Security

Please do NOT open a public issue for security concerns — see [SECURITY.md](./SECURITY.md).
