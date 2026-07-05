# Robust Testing System Roadmap for agent-trail

A 6-phase plan to build a comprehensive, production-grade testing system with richer assertions, lifecycle management, history tracking, export capabilities, and full protocol support.

**Status**: Plan document  
**Last updated**: 2026-05-28  
**Phases**: 6 (bug fixes → assertions → lifecycle → export → protocols → coverage)  
**Timeline estimate**: 6–8 days of implementation

---

## Executive Summary

The current testing system works but has:
- **8 real bugs** (false positives, truncation, regex fragility, no timeout)
- **Large assertion gaps** (only `expectedStatus` + `expectedBodyContains`)
- **No test history**, env vars, retry, setup/teardown, or parallel execution
- **No export to source control** (tests live only in SQLite)
- **Fragile coverage matching** (token-based, breaks on naming style)
- **Only REST-shaped** (no WebSocket, SSE, GraphQL)
- **Untested itself** (60% gap in server + core test coverage)

This roadmap fixes all of these incrementally, with each phase shipping independently.

---

## Phase 1 — Fix the 8 Real Bugs (1 PR, ~2 hrs)

**Goal**: Eliminate correctness issues that cause false positives, data loss, and timeouts.

| # | File | Problem | Fix |
|---|---|---|---|
| 1.1 | `test-runner.ts` | `ranSomething` false-positive when all tests skipped | Split `executed = pass + fail` from `total = pass + fail + skip`; `ranSomething = executedCount > 0`. Update `execution-manager.ts:412` to use the new field. |
| 1.2 | `TestRunner.tsx:744` | Sequence cases silently lose data > 800 chars | Parse JSON eagerly when storing `lastRun`; save to new `lastRun.responseJson` field (object, not string). Sequence templating reads the parsed object. |
| 1.3 | `test-runner.ts` | Pytest regex matches too broadly | Anchor pytest summary to `=+ .* (\d+) passed.* =+`; per-line matching requires `path::name`. |
| 1.4 | `tasks.ts:159` | `/api-request` hangs forever on broken endpoints | Add `AbortSignal.timeout(body.timeoutMs ?? 30_000)`. Return 408 on timeout. |
| 1.5 | `TestRunner.tsx:87` | `parseTestOutput` pytest regex unanchored | Anchor to `^path::name\s+(PASSED\|FAILED)` pattern; require `::` delimiter. |
| 1.6 | `TestRunner.tsx:49` | `extractApi` misses 2nd method in "POST /a or GET /b" | Use `matchAll()` instead of single `match()`; return array of `{method, path}`. |
| 1.7 | `TestRunner.tsx:702` | Malformed headers silently ignored | Parse and return `{headers, malformed: []}`. Show inline warning chip: "⚠ 1 invalid header line". |
| 1.8 | `generate-test-cases.ts` | `applyTemplate` injects unescaped values (path traversal / JSON injection) | Add `mode: "url" \| "json" \| "raw"` arg; URL-encode for paths, escape for JSON bodies. |

**Deliverables**:
- All 8 bugs gone
- No new features; backward-compatible API changes only
- 3 new regression tests (all-skipped case, truncated output sequence, timeout)
- Green CI

**PR scope**: `packages/core/src/adapters/test-runner.ts`, `packages/server/src/routes/tasks.ts`, `packages/web/src/components/task-detail/TestRunner.tsx`, `packages/web/src/components/task-detail/generate-test-cases.ts`, tests.

---

## Phase 2 — Richer Assertions (~1 day)

**Goal**: Move from magic `expectedStatus` + `expectedBodyContains` fields to a flexible, typed assertion list.

### Schema & Type Changes

New `Assertion` union in `packages/core/src/types/index.ts`:

```typescript
export type Assertion =
  | { kind: "status"; equals: number }
  | { kind: "status"; in: number[] }
  | { kind: "header"; name: string; equals?: string; matches?: string }
  | { kind: "body_contains"; text: string }
  | { kind: "body_matches"; pattern: string }           // regex
  | { kind: "json_path"; path: string; equals?: unknown; matches?: string }
  | { kind: "response_time_ms"; lt: number }
  | { kind: "exit_code"; equals: number };

export interface TestCase {
  id: string;
  criterionIndex: number;
  label: string;
  kind: "api" | "shell";
  method?: string;
  path?: string;
  body?: string;
  headers?: string;
  command?: string;
  
  // Replace expectedStatus / expectedBodyContains with:
  assertions: Assertion[];
  
  // ... rest of fields
}
```

### Migration & Backward Compat

- Add `migration v9` to `packages/server/src/storage/schema.sql`
- During migration, auto-convert existing `expectedStatus` → `{kind: "status", equals: N}` and `expectedBodyContains` → `{kind: "body_contains", text: "..."}` into the new `assertions` array
- Drop old columns after migration

### New Module: Assertion Evaluator

Create `packages/core/src/testing/assertions.ts` with pure function:

```typescript
export function evaluateAssertion(
  assertion: Assertion,
  response: { status?: number; headers?: Record<string, string>; body?: string; durationMs: number }
): AssertionResult {
  // Returns {label, passed, expected, actual}
}
```

**JSONPath support**:
- Use `jsonpath-plus` library (8 KB, zero external deps), OR
- Hand-roll a 60-line parser for `$.foo[0].bar` syntax if we want zero new deps

Heavily unit-tested: one test per assertion kind, edge cases (malformed JSON, missing paths, etc.).

### UI Changes

In `TestRunner.tsx`:
- Replace the fixed "Status code" + "Body contains" rows with a reusable assertion list component
- "+ Add assertion" → dropdown typeahead by kind
- Each kind has a small inline form (e.g., status → text field; json_path → path + operator + value)
- Assertion evaluation shows per-assertion breakdown in results

### Test Cases

Add tests for:
- Assertion evaluator: `packages/core/src/testing/assertions.test.ts`
- Each assertion kind
- JSONPath edge cases (missing keys, non-JSON body, regex errors)

**Deliverables**:
- Full migration to typed assertions
- UI list editor instead of magic fields
- `assertions.test.ts` with 20+ unit tests
- Zero user-visible regression (old cases transparently converted)

---

## Phase 3 — Lifecycle, Env, History, Tags (~2 days)

**Goal**: Enable setup/teardown, environment variables, run-history trends, retry logic, and selective test execution.

### 3a. Per-Case Timeout & Retry

Extend `TestCase`:

```typescript
export interface TestCase {
  // ... existing fields
  timeoutMs?: number;        // default 30_000 (30 s)
  retry?: { count: number; backoffMs: number };
}
```

UI: "⏱ 30 s · 🔁 2×" chip on case header; click to edit.

Runner: respect timeout on every case; on failure, retry up to `count` times with `backoffMs` between attempts.

### 3b. Environment Variables

New table in schema:

```sql
CREATE TABLE board_env (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  masked BOOLEAN DEFAULT 1,  -- hide value in UI unless ?reveal=1
  created_at TEXT,
  UNIQUE(board_id, key),
  FOREIGN KEY(board_id) REFERENCES boards(id)
);
```

New routes:
- `GET /api/boards/:boardId/env` — list keys + masked values
- `GET /api/boards/:boardId/env?reveal=1` — show plain values (permission check)
- `PUT /api/boards/:boardId/env` — upsert key=value pairs
- `DELETE /api/boards/:boardId/env/:key` — remove

UI: "Env" tab in BoardSettings; table editor with "Reveal" toggle.

Substitution: extend `applyTemplate()` to handle `{{env.API_KEY}}`; warn if key not found.

### 3c. Setup & Teardown Hooks

Extend `TestCase`:

```typescript
export interface TestCase {
  // ... existing fields
  setup?: TestCaseHook[];    // run before this case, results not stored
  teardown?: TestCaseHook[];  // run after, results not stored
}

export interface TestCaseHook {
  id: string;
  kind: "api" | "shell";
  // ... same fields as TestCase (method, path, body, command, etc.)
  // But no assertions, no lastRun, no retry
}
```

Each hook is a simple API call or shell command; failures halt the sequence. UI: small "+" to expand setup/teardown lists per case.

### 3d. Run History & Trends

New table:

```sql
CREATE TABLE test_case_runs (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  passed BOOLEAN,
  duration_ms INTEGER,
  output TEXT,
  assertions_json TEXT,   -- JSON array of {label, passed, expected, actual}
  ran_at TEXT,
  created_at TEXT,
  FOREIGN KEY(test_case_id) REFERENCES tasks(test_cases JSON),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

Denormalized cache: `TestCase.lastRun` is always the latest row (eager update when case runs).

New route: `GET /api/tasks/:taskId/test-runs?caseId=…&limit=14&days=14` → returns `{total, passed, trend: [date, passes, fails]}`.

UI: Tiny 14-day sparkline next to each case label; hover tooltip shows "12 green, 2 red in last 14 days".

### 3e. Tags & Selective Execution

Extend `TestCase`:

```typescript
export interface TestCase {
  // ... existing fields
  tags?: string[];  // e.g. ["smoke", "regression", "slow"]
}
```

UI:
- Pill tag on case header
- "Run controls" dropdown: "▶ Run all" / "▶ Run #smoke" / "▶ Run #fast"
- Persist last filter per task in local session storage

Runner: when filter is set, skip cases that don't have all filter tags.

### Storage Migration

Add `migration v10` to add the three new tables, extend `TestCase` JSON schema.

**Deliverables**:
- Timeout + retry per case
- Board env-var storage + substitution
- Setup/teardown hooks (no assertions)
- Run-history table + sparkline UI
- Tag filtering + selective run
- All under new migrations

---

## Phase 4 — Parallel Runner & Export (~1 day)

**Goal**: Run independent cases concurrently; export test cases to source control.

### 4a. Parallel Execution

Build a DAG from `TestCase.dependsOnCaseId`. Independent roots run concurrently (cap: 4, configurable).

Implementation: client-side in `TestRunner.tsx`. When user hits "▶ Run all":
1. Compute DAG from `dependsOnCaseId` relationships
2. Identify roots (no incoming edges)
3. Spawn N concurrent promises (limit 4) for independent cases
4. As each completes, unblock its dependents
5. Show live badge: "3/8 running, 2 queued"

Test: add a unit test for the DAG traversal logic.

### 4b. Export to bun:test / pytest

New skill: `export-tests` button on task detail.

**For bun:test** (`board.implementation_dir` is TypeScript/Node):
- Generate `tests/<task-slug>.test.ts`
- Template:
  ```typescript
  import { describe, it, expect } from "bun:test";
  
  describe("Task: <title>", () => {
    it("POST /notes returns 201", async () => {
      const res = await fetch("http://localhost:3001/notes", {
        method: "POST",
        body: JSON.stringify({ title: "Test" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBeDefined();
    });
  });
  ```
- One `it()` per case, assertions inlined
- Parameterize base URL from env var or `.env`
- Round-trip safe: wrap auto-generated code in `// agent-trail:auto-start` / `// agent-trail:auto-end` markers; preserve user edits outside

**For pytest** (`board.implementation_dir` is Python):
- Generate `tests/test_<task-slug>.py`
- Template:
  ```python
  import pytest
  import requests
  
  BASE_URL = os.getenv("TEST_BASE_URL", "http://localhost:3001")
  
  class TestTaskName:
    def test_post_notes_returns_201(self):
      res = requests.post(f"{BASE_URL}/notes", json={"title": "Test"})
      assert res.status_code == 201
      assert res.json()["id"]
  ```
- Same delimiters for round-trip safety

Route: `POST /api/tasks/:taskId/export-tests?format=bun|pytest` → returns file contents.

UI button behavior: show a dialog "Export to which location?" → "tests/task.test.ts" with a download button, OR "write to repo (need local access)".

**Deliverables**:
- Parallel runner in UI with live feedback
- Bun export template
- Pytest export template
- Round-trip safe delimiters
- Tests for DAG traversal

---

## Phase 5 — Coverage Matcher v2 & Protocol Expansion (~2 days)

**Goal**: Match tests to criteria more reliably; support non-REST protocols.

### 5a. OpenAPI-Aware Coverage Matcher

If `board.implementation_dir` contains `openapi.json` or `openapi.yaml`:
1. Parse once at task load
2. Build index: `{method, path}` → operationId
3. Extract `METHOD /path` from Claude test name
4. Lookup in OpenAPI; match by operationId, summary, or description
5. Much higher fidelity than token overlap

Fallback: if no OpenAPI or lookup fails, use Phase 1's improved token matcher.

New module: `packages/core/src/testing/openapi-matcher.ts`.

Test: mock OpenAPI spec + test names; verify matches work.

### 5b. WebSocket Support

Extend `TestCase.kind`:

```typescript
export interface TestCase {
  kind: "api" | "shell" | "websocket" | "sse" | "graphql";
}

// When kind === "websocket":
export interface WebSocketCase {
  url: string;
  send: Array<{message: string; waitForResponse: boolean}>;
  expect: Array<Assertion>;  // match each response against assertions
  timeoutMs?: number;
}
```

Runner: open WebSocket, send messages, collect responses, assert on each. Fail if timeout before all expected messages.

### 5c. SSE Support

```typescript
// When kind === "sse":
export interface SSECase {
  url: string;
  expectEventCount: number;
  assertions: Assertion[];  // apply to each event
}
```

Runner: open EventSource, listen for N events, parse as JSON, assert on each.

### 5d. GraphQL Support

```typescript
// When kind === "graphql":
export interface GraphQLCase {
  endpoint: string;
  query: string;
  variables?: Record<string, unknown>;
  assertions: Assertion[];  // JSONPath into {data, errors}
}
```

Runner: POST to endpoint with `{query, variables}`, assert on response.

UI: case editor variant for each protocol with protocol-specific fields.

Tests: unit tests for each protocol's parser/executor.

**Deliverables**:
- OpenAPI matcher module + tests
- WebSocket, SSE, GraphQL case kinds
- UI editors for each
- Executor logic for each
- Integration tests (mock WS server, EventSource mock, etc.)

---

## Phase 6 — Test the Testing System (~1 day)

**Goal**: Eliminate the 60% coverage gap in the testing system itself.

### 6a. HTTP Route Tests

One test file per route in `packages/server/src/routes/`:

- `tasks.test.ts` — tests for `POST /test`, `/api-request`, `/custom-run`, `/discover-urls`
- `boards.test.ts` — board CRUD, dev-server config updates
- `plan.test.ts` — PRD → task graph planning
- etc.

Use same pattern as `execution-manager.test.ts`: temp DB, mocked child processes, assertions on DB state + response.

**Coverage targets**:
- Happy path per route
- Error cases (404, 400, 422)
- Permission checks
- Boundary conditions (empty input, huge payload, etc.)

### 6b. Adapter & Core Tests

- `test-runner.ts`: unit tests for each runner type (bun, jest, vitest, pytest) with real fixture stdout
- `claude-code.ts`: process lifecycle tests (spawn, signal handling, stream parsing)
- `assertions.ts` (Phase 2): property tests for each assertion kind
- `openapi-matcher.ts` (Phase 5): fixture-based spec matching

### 6c. Execution Manager Tests (new coverage)

Expand `execution-manager.test.ts`:
- `verify_tests` phase path (currently untested)
- `runBoard` / `runScope` board-runner loop (currently untested)
- Listener-leak regression (no listener fires → hang)

### 6d. Runner Package Tests

- `packages/runner/src/manager.test.ts`: process adoption on boot, state persistence, PID cleanup
- `packages/runner/src/state.test.ts`: state file atomicity

### 6e. CI & Coverage Reporting

Create `.github/workflows/test.yml`:

```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test --coverage
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```

Add coverage badge to README.

### 6f. Per-Package Test Scripts

Each package's `package.json`:

```json
{
  "scripts": {
    "test": "bun test",
    "test:watch": "bun test --watch"
  }
}
```

Allows `bun test -F @agent-trail/server` for per-package runs.

**Deliverables**:
- 8 new test files covering all routes + adapters
- Coverage > 60% on `packages/server` + `packages/core`
- CI workflow + codecov integration
- Per-package test scripts
- README badge

---

## Implementation Sequence & Dependencies

```
Phase 1 (bugs)  ──────────────────────────────┐
                                              │
                                              ▼
Phase 2 (assertions)  ────────────────────────┤
         │                                    │
         ▼                                    │
Phase 3 (lifecycle)  ──────────────────────────┤
         │                                    │
         ▼                                    │
Phase 4 (parallel + export)  ──────────────────┤
         │                                    │
         ▼                                    │
Phase 5 (matcher v2 + protocols)  ─────────────┤
                                              │
Phase 6 (testing infrastructure)  ────────────┘
        (can run in parallel from Phase 1)
```

**Recommended commit strategy**:
- Phase 1: single PR
- Phase 2: single PR (depends on Phase 1)
- Phase 3: single PR (depends on Phase 2)
- Phase 4: single PR (depends on Phase 3)
- Phase 5: two PRs (matcher v2, then protocols)
- Phase 6: two PRs (routes, then runner/core)

---

## Locked Decisions (2026-05-29)

| Question | Decision | Rationale |
|---|---|---|
| Scope | **All 6 phases** | Full roadmap |
| JSONPath | **`jsonpath-plus`** (npm) | Mature, RFC 9535 subset, 8 KB, handles slice/filter/recursive descent — hand-rolled parser would be fragile on real responses |
| Env-var storage | **Encrypted at rest** (AES-256-GCM) | Master key in `~/.agent-trail/master.key` (mode 0600), generated on first run. Per-value IV. Store `{ciphertext, iv, tag}` base64 in DB. |
| Export formats | **Both `bun:test` + `pytest`** in Phase 4 | Same PR, same delimiter scheme, runtime picked by `board.implementation_dir` detection |
| CI | **GitHub Actions** + Codecov | `oven-sh/setup-bun@v1`, runs `bun test --coverage`, publishes to codecov.io. README badge. |
| Coverage threshold | **Start warn-only**, gate at **50%** after Phase 6 | Repo currently sits around 10% — soft-start, then ratchet up. Codecov status check informs but doesn't block until Phase 6 lands. |

---

## Success Criteria

After all 6 phases:

- ✅ Zero false positives in TDD gate
- ✅ No silent data loss in sequences
- ✅ Tests can express 90% of assertion types (status, headers, body, JSON, time, exit code)
- ✅ Can test with retries, env vars, setup/teardown
- ✅ Run history shows trends; can detect flakes
- ✅ Parallel execution for independent cases
- ✅ Test cases exported to source control (bun:test + pytest)
- ✅ Coverage matcher reliable enough for non-REST protocols
- ✅ WebSocket, SSE, GraphQL support
- ✅ Testing system itself > 60% covered
- ✅ CI gate on coverage regression

---

## Notes

- Each phase is a standalone improvement and can ship independently
- Backward compatibility maintained throughout (migrations handle old cases)
- No breaking changes to the public API (all new fields optional)
- User-visible regressions will be caught by the Phase 6 tests before shipping

