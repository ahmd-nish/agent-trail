import { Hono } from "hono";
import { getDb } from "../db.ts";

// PRD_TESTING T5.1 + T5.2 — test-history / test-cases export + retention.
// Bidirectional sync to `.inventarium/tests.json` is teased here as JSON
// export + import against the same shape; a filesystem watcher lives in a
// later phase.

const DEFAULT_RETENTION_DAYS = 90;

export const testHistoryRouter = new Hono();

// T5.2 — export run history for external analysis. `format=csv|json`.
testHistoryRouter.get("/tasks/:taskId/test-runs.:format", (c) => {
  const { taskId, format } = c.req.param();
  const db = getDb();
  const rows = db.query(`
    SELECT id, test_case_id, task_id, passed, duration_ms, attempts, output, assertions_json,
           ran_at, outcome, redaction_applied, server_recorded
    FROM test_case_runs
    WHERE task_id = ?
    ORDER BY ran_at DESC
  `).all(taskId) as Array<Record<string, unknown>>;

  if (format === "csv") {
    const columns = ["id", "test_case_id", "task_id", "passed", "duration_ms", "attempts", "ran_at", "outcome", "redaction_applied", "server_recorded"];
    const header = columns.join(",");
    const escape = (v: unknown): string => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) => columns.map((k) => escape(r[k])).join(","));
    return new Response([header, ...lines].join("\n"), {
      headers: { "Content-Type": "text/csv; charset=utf-8" },
    });
  }
  if (format === "json") {
    return c.json({ runs: rows });
  }
  return c.json({ error: "format must be csv or json" }, 400);
});

// T5.2 — prune run rows older than the retention window. POST is intentional
// so it's not accidentally hit by a browser; scheduled inventarium loops can
// call it daily.
testHistoryRouter.post("/tasks/:taskId/test-runs/prune", async (c) => {
  const { taskId } = c.req.param();
  const body = await c.req.json<{ retentionDays?: number }>().catch(() => ({}));
  const days = Number(body.retentionDays ?? DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(days) || days <= 0) {
    return c.json({ error: "retentionDays must be a positive number" }, 400);
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();
  const info = db.query("DELETE FROM test_case_runs WHERE task_id = ? AND ran_at < ?").run(taskId, cutoff);
  return c.json({ deleted: info.changes, cutoff });
});

// T5.1 — export the task's test cases (JSON blob on the task row) so a repo
// can commit `.inventarium/tests.json` and diff future changes.
testHistoryRouter.get("/tasks/:taskId/tests-export", (c) => {
  const { taskId } = c.req.param();
  const db = getDb();
  const row = db.query("SELECT test_cases, updated_at FROM tasks WHERE id = ?").get(taskId) as
    { test_cases: string | null; updated_at: string } | null;
  if (!row) return c.json({ error: "task not found" }, 404);
  return c.json({
    version: 1,
    exportedAt: new Date().toISOString(),
    taskId,
    taskUpdatedAt: row.updated_at,
    testCases: JSON.parse(row.test_cases ?? "[]"),
  });
});

// T5.1 — import: replace the task's test cases with the provided array.
// Optimistic-lock check optional (falls back to overwrite when not provided).
testHistoryRouter.post("/tasks/:taskId/tests-import", async (c) => {
  const { taskId } = c.req.param();
  const body = await c.req.json<{ testCases: unknown[]; ifMatchUpdatedAt?: string }>().catch(() => null);
  if (!body || !Array.isArray(body.testCases)) return c.json({ error: "testCases array is required" }, 400);
  const db = getDb();
  const existing = db.query("SELECT updated_at FROM tasks WHERE id = ?").get(taskId) as
    { updated_at: string } | null;
  if (!existing) return c.json({ error: "task not found" }, 404);
  if (body.ifMatchUpdatedAt && existing.updated_at !== body.ifMatchUpdatedAt) {
    return c.json({ error: "task has been modified since your last read", currentUpdatedAt: existing.updated_at }, 409);
  }
  const now = new Date().toISOString();
  db.query("UPDATE tasks SET test_cases = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(body.testCases), now, taskId);
  return c.json({ imported: body.testCases.length, taskUpdatedAt: now });
});
