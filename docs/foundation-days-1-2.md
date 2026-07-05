# Foundation — Days 1–2

**Goal:** Land a clean baseline before Week 1's fun work starts.

Four jobs. Each is small. None are negotiable.

1. Commit to the name `agent-trail` (sed pass)
2. Add a per-execution timeout
3. Multi-tenancy groundwork (`workspace_id` migration)
4. Delete the DAG view

Time budget: 1 long day for an experienced dev, 2 days at a comfortable pace.

---

## Job 1 — Name commitment

The name is currently split between `vibe-board` (code, MCP server, env vars, default paths, README) and `agent-trail` (directory, schema comment, project memory). Every install today produces user confusion. Fix once, fix everywhere.

### Files to update

**User-facing strings (must change):**
- `README.md` — every reference
- `package.json` — `"name"`, `"description"`
- `packages/{cli,core,server,web,mcp-server,runner}/package.json` — `"name"` fields (`@vibe-board/*` → `@agent-trail/*`)
- `packages/cli/package.json` — `"bin"` field (`vibe-board` → `agent-trail`)
- `packages/server/src/index.ts:36` — startup log message
- `packages/core/src/mcp/board-server.ts:19` — MCP server name (`vibe-board` → `agent-trail`)
- `packages/core/src/mcp/board-server.ts:27` — tool description
- `packages/core/src/mcp/ask-human.ts:30, 41` — same
- `packages/core/src/adapters/claude-code.ts:32` — system prompt boilerplate
- `packages/core/src/adapters/mcp-config.ts:48, 63, 69` — scoped server name + tmp file prefix

**Filesystem paths:**
- `packages/server/src/routes/boards.ts:11, 20` — `~/vibe-board-runs/` → `~/agent-trail-runs/`
- `packages/server/src/routes/plan.ts:15` — same
- `packages/core/src/storage/paths.ts` — `DB_FILENAME = "agent-trail.db"`
- Delete `vibe-board.db` from repo root once `agent-trail.db` is the working copy

**Env vars (back-compat shim):**
- `packages/core/src/mcp/ask-human.ts:16, 22` — read `AGENT_TRAIL_DB_PATH` first, fall back to `VIBE_BOARD_DB_PATH` for one release with a `console.warn`
- `packages/core/src/mcp/board-server.ts:10, 12` — same
- `packages/core/src/storage/paths.ts` — `resolveDbPath` checks new var first, old var with deprecation log, then default
- `packages/core/src/adapters/mcp-config.ts:52–54` — emit both old + new env vars to the spawned MCP for one release

**Internal comments:**
- `packages/server/src/execution-manager.ts:330, 562, 563` — comments referencing `vibe-board`
- Any `// vibe-board ...` comments — rewrite or delete

### What NOT to change
- Existing user data in `vibe-board.db` should keep working. The migration is: rename the file on next startup. Add a migration v6:

```ts
{
  version: 6,
  description: "Rename vibe-board.db → agent-trail.db (handled at file level)",
  up: () => { /* no-op: file rename happens in getDb() if old exists, new doesn't */ },
}
```

In `getDb()`: before opening, if `agent-trail.db` doesn't exist but `vibe-board.db` does in the same dir, rename it. Log it. One-time, irreversible — but reversible by renaming back manually.

### Acceptance criteria
- `grep -rn "vibe-board" packages/ scripts/ README.md` returns zero hits (except in deprecation shim comments)
- Fresh install creates `agent-trail.db`, not `vibe-board.db`
- Existing v0.1 user's DB auto-renames on first v0.2 startup
- `bun cli init` opens the browser and the title bar says `agent-trail`

---

## Job 2 — Execution timeout

**Problem:** `spawnClaudeCode` has no timeout. If `claude` hangs (process alive but no stdout for hours), the task is stuck `in_progress` until the user hits Stop or the server restarts.

### Schema addition

Add a board-level field for the timeout, with a sane default and a per-task override option for the future (don't expose the per-task override in v0.2 UI):

Migration v7:
```sql
ALTER TABLE boards ADD COLUMN execution_timeout_ms INTEGER NOT NULL DEFAULT 1200000;  -- 20 min
```

Default: 20 minutes. Reasoning: long enough for non-trivial tasks, short enough that a hang doesn't waste a whole afternoon.

### Implementation

**`packages/core/src/adapters/claude-code.ts`:**
- Add `timeoutMs` to `SpawnOpts`
- `setTimeout` armed when spawn succeeds
- On timeout: emit `onError(new Error("Timed out after Xm"))` and kill the process group (same SIGTERM → SIGKILL pattern as `stop`)
- Clear the timeout on first `result` event or `close`

**`packages/server/src/execution-manager.ts`:**
- Read `execution_timeout_ms` from the board row when running a task
- Pass to `spawnClaudeCode`

**`packages/server/src/routes/boards.ts`:**
- Accept `executionTimeoutMs` in the PATCH body (validate 30s ≤ x ≤ 4hr)
- `rowToBoard` returns it

**Web — `BoardSettings.tsx`:**
- Add a slider or number input: "Execution timeout" with options "5min / 20min / 1hr / 4hr". Stretch — for v0.2 a single-number input is fine.

### Acceptance criteria
- Run a task with a deliberately-hanging prompt (e.g., `sleep 9999`). Verify it terminates at the timeout boundary and lands the task in `blocked` with `last_error = "Timed out after 20m"`.
- Verify the timeout cleans up correctly when the task completes normally (no spurious kill after the timeout fires post-completion).

---

## Job 3 — Multi-tenancy groundwork

The paid pivot (cloud collab) is dead-on-arrival if every row needs backfilling later. Do it now while the data is small.

### Migration v8

```sql
ALTER TABLE boards   ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE tasks    ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE executions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE telemetry_events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE artifacts ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE decision_tickets ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';

CREATE INDEX idx_boards_workspace ON boards(workspace_id);
CREATE INDEX idx_tasks_workspace_board ON tasks(workspace_id, board_id);
```

### Code groundwork

**Create `packages/server/src/auth.ts`:**
```ts
export interface CurrentUser { id: string; workspaceId: string; }

export function getCurrentUser(_c?: unknown): CurrentUser {
  // v0.2: single-user local install. Phase 2: derive from session cookie.
  return { id: "local", workspaceId: "local" };
}
```

**Every route** gets a one-line addition: `const user = getCurrentUser(c);` and every INSERT includes `workspace_id`. Every list query filters by `workspace_id`. Don't add the filter to `WHERE` clauses today (would be no-ops); just route everything through the helper so retrofitting is mechanical.

**Types:**
- Add `workspaceId: string` to `Board`, `Task`, `Execution`. Row mappers populate it.

### Acceptance criteria
- All new rows have `workspace_id = 'local'`
- A `SELECT COUNT(*) FROM tasks WHERE workspace_id != 'local'` returns 0
- The data model is technically ready for multi-workspace without further migration

---

## Job 4 — Delete DAG view

**Per user request: only this view is cut.** Keep Epic, keep TDD machinery, keep everything else.

### Files to delete
- `packages/web/src/components/DagView.tsx`

### Files to update
- `packages/web/src/App.tsx` — remove `"dag"` from the `View` union, remove the DAG button from the view switcher, remove the DAG render branch in `<main>`
- `packages/web/src/lib/api.ts` — no DAG-specific endpoints to remove (DAG was client-side)

### Acceptance criteria
- View switcher shows: Kanban / Epics / Dashboard (3 tabs, was 4)
- No dead imports
- `bunx tsc` doesn't gain new errors

---

## Order of operations

Do in this order to minimize merge pain:

1. **Job 4 (delete DAG)** — smallest blast radius, gets out of the way
2. **Job 3 (workspace_id)** — pure additive migration, doesn't change behavior
3. **Job 2 (timeout)** — small, contained
4. **Job 1 (rename)** — biggest sed pass, do last so it doesn't conflict with the others

Single PR is fine. Title: `chore(v0.2): foundation — rename, timeout, multi-tenant prep, drop DAG`.

---

## Definition of done

- [ ] All four jobs land
- [ ] `bun test packages/` — 45+ tests still pass
- [ ] Manual: create board → add task → run → complete. Verify it works end-to-end with the new name everywhere.
- [ ] Manual: rename test — copy your existing `vibe-board.db` to a sandbox, run new server, verify it becomes `agent-trail.db` and your data is intact.
- [ ] Tag and commit. `git tag v0.2.0-foundation`. Week 1 starts from a clean tag.
