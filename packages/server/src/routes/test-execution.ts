import { Hono } from "hono";
import { getDb, rowToTask, listBoardEnv } from "../db.ts";
import type { TestCase } from "../../../core/src/types/index.ts";
import { executeCase } from "../testing/executor.ts";
import { validateCases } from "../testing/validate-cases.ts";
import { generateCasesWithAgent, makeClaudeCaseGenRunner } from "../testing/generate-cases.ts";
import { computeCoverage } from "../testing/coverage.ts";

// PRD_TESTING T1 — Test Execution Service routes.
//   POST /api/tests/:caseId/execute             — evidence-grade single run
//   PATCH /api/tests/:taskId/cases/:caseId       — granular case edit w/ optimistic lock

export const testExecutionRouter = new Hono();

interface ExecuteBody {
  /** Which task owns the case. Required — cases don't have a global namespace. */
  taskId: string;
  /** Prior in-chain response for {{prev.*}}. Missing = first case in chain. */
  prev?: unknown;
  /** Named chain scope for {{cases.ALIAS.*}} (T4.1). */
  cases?: Record<string, unknown>;
  /** Base URL prefix for `path` values. */
  baseUrl?: string;
}

testExecutionRouter.post("/tests/:caseId/execute", async (c) => {
  const { caseId } = c.req.param();
  const body = await c.req.json<ExecuteBody>().catch(() => ({} as ExecuteBody));
  if (!body.taskId) return c.json({ error: "taskId is required" }, 400);

  const db = getDb();
  const taskRow = db.query("SELECT * FROM tasks WHERE id = ?").get(body.taskId) as Parameters<typeof rowToTask>[0] | null;
  if (!taskRow) return c.json({ error: "task not found" }, 404);
  const task = rowToTask(taskRow);
  const testCase = task.testCases.find((tc) => tc.id === caseId);
  if (!testCase) return c.json({ error: "test case not found on this task" }, 404);

  // Board env (plaintext) is loaded server-side and NEVER returned to the
  // client. Every entry currently held in board_env is treated as a secret
  // for redaction purposes — future work: per-key flag.
  const boardId = taskRow.board_id;
  const envEntries = listBoardEnv(boardId, /*reveal*/ true);
  const env: Record<string, string> = {};
  const boardSecrets = new Set<string>();
  for (const e of envEntries) {
    env[e.key] = e.value;
    boardSecrets.add(e.key);
  }

  const result = await executeCase({
    case: testCase,
    baseUrl: body.baseUrl,
    env,
    boardSecrets,
    prev: body.prev,
    cases: body.cases,
  });

  // Persist an evidence-grade row with server timestamps + the redacted output.
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO test_case_runs
      (id, test_case_id, task_id, passed, duration_ms, attempts, output, assertions_json, ran_at, outcome, redaction_applied, server_recorded)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    runId, caseId, body.taskId,
    result.outcome === "pass" || result.outcome === "flaky_pass" ? 1 : 0,
    result.durationMs,
    result.attempts,
    result.redactedOutput,
    JSON.stringify(result.assertionResults),
    now,
    result.outcome,
    result.redactionApplied ? 1 : 0,
  );

  return c.json({
    runId,
    outcome: result.outcome,
    passed: result.outcome === "pass" || result.outcome === "flaky_pass",
    attempts: result.attempts,
    durationMs: result.durationMs,
    status: result.status,
    assertions: result.assertionResults,
    responseJson: result.responseJson,
    output: result.redactedOutput,
    unresolvedPlaceholders: result.unresolvedPlaceholders,
    ranAt: now,
  });
});

// PRD_TESTING T4.3 — validate a task's testCases against the board env at
// save time. Returns the list of unknown-env-key placeholders so the UI can
// warn early (not at run time).
// PRD_OPEN_SOURCE §B — coverage taxonomy audit. Returns per-criterion
// happy/negative/edge counts + "meets bar" flag so the UI can highlight
// under-covered success criteria (and CI can fail the plan-review if strict).
testExecutionRouter.get("/tests/:taskId/coverage", (c) => {
  const { taskId } = c.req.param();
  const db = getDb();
  const taskRow = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Parameters<typeof rowToTask>[0] | null;
  if (!taskRow) return c.json({ error: "task not found" }, 404);
  const task = rowToTask(taskRow);
  return c.json(computeCoverage(task.id, task.title, task.successCriteria, task.testCases));
});

testExecutionRouter.get("/tests/:taskId/validate", (c) => {
  const { taskId } = c.req.param();
  const db = getDb();
  const taskRow = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Parameters<typeof rowToTask>[0] | null;
  if (!taskRow) return c.json({ error: "task not found" }, 404);
  const task = rowToTask(taskRow);
  const envRows = listBoardEnv(taskRow.board_id, false);
  const known = new Set(envRows.map((e) => e.key));
  const warnings = validateCases(task.testCases, known);
  return c.json({ warnings });
});

// PRD_TESTING T1.5 — granular per-case PATCH with optimistic locking. Old
// path was "PUT the whole testCases array" which silently clobbered a
// concurrent edit from another tab or from a running agent.
testExecutionRouter.patch("/tests/:taskId/cases/:caseId", async (c) => {
  const { taskId, caseId } = c.req.param();
  const body = await c.req.json<{ ifMatchUpdatedAt?: string; patch: Partial<TestCase> }>().catch(() => ({ patch: {} }));
  if (!body?.patch) return c.json({ error: "patch is required" }, 400);

  const db = getDb();
  const taskRow = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Parameters<typeof rowToTask>[0] | null;
  if (!taskRow) return c.json({ error: "task not found" }, 404);
  if (body.ifMatchUpdatedAt && taskRow.updated_at !== body.ifMatchUpdatedAt) {
    return c.json({ error: "task has been modified since your last read", currentUpdatedAt: taskRow.updated_at }, 409);
  }
  const task = rowToTask(taskRow);
  const idx = task.testCases.findIndex((tc) => tc.id === caseId);
  if (idx < 0) return c.json({ error: "test case not found on this task" }, 404);

  const merged: TestCase = { ...task.testCases[idx]!, ...body.patch, id: caseId };
  const next = [...task.testCases];
  next[idx] = merged;
  const now = new Date().toISOString();
  db.query("UPDATE tasks SET test_cases = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(next), now, taskId);

  return c.json({ testCase: merged, taskUpdatedAt: now });
});

// PRD_TESTING T3.2 — on-demand agent case-authoring.
// Dispatches to the claude CLI adapter (mockable via INVENTARIUM_CASE_GEN_MOCK)
// with the task's criteria + any board-scoped `case_examples` for T3.4
// round-trip learning. Returns the generated cases WITHOUT persisting them —
// the caller decides which to keep (they'll usually POST them back via
// PATCH tasks or the case-specific PATCH above).
testExecutionRouter.post("/tasks/:taskId/generate-cases", async (c) => {
  const { taskId } = c.req.param();
  const body = await c.req.json<{ baseUrl?: string }>().catch(() => ({}));
  const db = getDb();
  const taskRow = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Parameters<typeof rowToTask>[0] | null;
  if (!taskRow) return c.json({ error: "task not found" }, 404);
  const task = rowToTask(taskRow);

  // PRD_TESTING T3.4 — pull the board's prior <original, fixed> case pairs
  // for few-shot injection. Cap at 6 to keep the prompt lean.
  const exampleRows = db.query(
    "SELECT original_json, fixed_json, note FROM case_examples WHERE board_id = ? ORDER BY created_at DESC LIMIT 6"
  ).all(taskRow.board_id) as Array<{ original_json: string; fixed_json: string; note: string | null }>;
  const examples = exampleRows.map((r) => ({
    original: JSON.parse(r.original_json) as TestCase,
    fixed: JSON.parse(r.fixed_json) as TestCase,
    note: r.note ?? undefined,
  }));

  try {
    const runner = makeClaudeCaseGenRunner();
    const result = await generateCasesWithAgent({
      task, examples, existing: task.testCases,
      baseUrl: body.baseUrl,
    }, runner);
    return c.json({
      cases: result.cases,
      source: result.source,
      exampleCount: examples.length,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// PRD_TESTING T3.4 — save a <original, fixed> case pair as a board-scoped
// example so future generation runs can learn the local schema.
testExecutionRouter.post("/boards/:boardId/case-examples", async (c) => {
  const { boardId } = c.req.param();
  const body = await c.req.json<{ original: TestCase; fixed: TestCase; note?: string }>().catch(() => null);
  if (!body?.original || !body?.fixed) return c.json({ error: "original and fixed are required" }, 400);
  const db = getDb();
  const boardExists = db.query("SELECT id FROM boards WHERE id = ?").get(boardId);
  if (!boardExists) return c.json({ error: "board not found" }, 404);
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO case_examples (id, board_id, original_json, fixed_json, note) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, boardId, JSON.stringify(body.original), JSON.stringify(body.fixed), body.note ?? null);
  return c.json({ id, savedAt: new Date().toISOString() }, 201);
});

// List examples for a board (agents + UI use this to show what's been learned).
testExecutionRouter.get("/boards/:boardId/case-examples", (c) => {
  const { boardId } = c.req.param();
  const db = getDb();
  const rows = db.query(
    "SELECT id, original_json, fixed_json, note, created_at FROM case_examples WHERE board_id = ? ORDER BY created_at DESC",
  ).all(boardId) as Array<{ id: string; original_json: string; fixed_json: string; note: string | null; created_at: string }>;
  return c.json({
    examples: rows.map((r) => ({
      id: r.id,
      original: JSON.parse(r.original_json) as TestCase,
      fixed: JSON.parse(r.fixed_json) as TestCase,
      note: r.note,
      createdAt: r.created_at,
    })),
  });
});

// Delete a specific example (user removes a bad correction).
testExecutionRouter.delete("/case-examples/:exampleId", (c) => {
  const { exampleId } = c.req.param();
  const db = getDb();
  const info = db.query("DELETE FROM case_examples WHERE id = ?").run(exampleId);
  if (info.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
