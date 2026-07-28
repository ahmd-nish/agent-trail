import { Hono } from "hono";
import { basename } from "node:path";
import { getDb } from "../db.ts";
import { append as appendKnowledge } from "../../../core/src/knowledge/store.ts";
import { detectAuthor } from "../../../core/src/context/store.ts";
import { resolveProjectRoot } from "../../../core/src/storage/paths.ts";

// PRD_OPEN_SOURCE §4.4b — steering queue.
//
// The user (or Scout v2) drops info/alterations onto a running task without
// interrupting the current agent iteration. Steers land in the DB with
// consumed_at=NULL, get merged into the L1 context pack at the NEXT spawn
// (fresh-context re-run / phase transition), then marked consumed.
//
//   POST   /api/tasks/:id/steer   { text, kind? }
//   GET    /api/tasks/:id/steer[?includeConsumed=1]
//   DELETE /api/steering/:id      — cancel a pending steer

export const steeringRouter = new Hono();

interface SteerRow {
  id: string;
  task_id: string;
  kind: string;
  text: string;
  consumed_at: string | null;
  created_at: string;
}

function rowToSteer(r: SteerRow) {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind,
    text: r.text,
    consumedAt: r.consumed_at,
    createdAt: r.created_at,
  };
}

steeringRouter.post("/tasks/:taskId/steer", async (c) => {
  const { taskId } = c.req.param();
  const body = await c.req.json<{ text?: string; kind?: string }>().catch(() => ({}));
  if (!body.text?.trim()) return c.json({ error: "text is required" }, 400);
  const kind = (body.kind ?? "note").trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(kind)) return c.json({ error: "kind must be 1-32 chars, alphanumeric/underscore/dash" }, 400);

  const db = getDb();
  const task = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId);
  if (!task) return c.json({ error: "task not found" }, 404);

  const id = `steer-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.query(
    "INSERT INTO steering (id, task_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, taskId, kind, body.text.trim(), now);
  const row = db.query("SELECT * FROM steering WHERE id = ?").get(id) as SteerRow;

  // knowledgelayer §4.1 — steer becomes an attributed event so the multiplayer
  // future ("Sarah redirected this agent yesterday") has a substrate.
  try {
    const root = resolveProjectRoot();
    const author = detectAuthor(root);
    appendKnowledge(db, {
      workspaceId: "local",
      projectId: basename(root) || "local",
      actorKind: "human",
      actorId: author,
      actorName: author,
      taskId,
      executionId: null,
      type: "steer",
      scope: `task:${taskId}`,
      subject: `steer (${kind}) on task ${taskId.slice(0, 8)}`,
      body: body.text.trim(),
      paths: [],
      confidence: "ruling",
      supersedes: null,
    });
  } catch (err) {
    console.warn(`[steering] knowledge event failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return c.json(rowToSteer(row), 201);
});

steeringRouter.get("/tasks/:taskId/steer", (c) => {
  const { taskId } = c.req.param();
  const includeConsumed = c.req.query("includeConsumed") === "1";
  const db = getDb();
  const where = includeConsumed ? "task_id = ?" : "task_id = ? AND consumed_at IS NULL";
  const rows = db.query(`SELECT * FROM steering WHERE ${where} ORDER BY created_at ASC`)
    .all(taskId) as SteerRow[];
  return c.json(rows.map(rowToSteer));
});

steeringRouter.delete("/steering/:steerId", (c) => {
  const { steerId } = c.req.param();
  const db = getDb();
  const row = db.query("SELECT id FROM steering WHERE id = ?").get(steerId);
  if (!row) return c.json({ error: "not found" }, 404);
  db.query("DELETE FROM steering WHERE id = ?").run(steerId);
  return c.json({ ok: true });
});
