import { Hono } from "hono";
import { getDb, rowToTask } from "../db.ts";
import type { Task, TaskStatus, Priority, AgentKind } from "../../../core/src/types/index.ts";

export const tasksRouter = new Hono();

// List tasks for a board
tasksRouter.get("/boards/:boardId/tasks", (c) => {
  const { boardId } = c.req.param();
  const db = getDb();
  const rows = db
    .query("SELECT * FROM tasks WHERE board_id = ? ORDER BY created_at ASC")
    .all(boardId) as Parameters<typeof rowToTask>[0][];
  return c.json(rows.map(rowToTask));
});

// Create task
tasksRouter.post("/boards/:boardId/tasks", async (c) => {
  const { boardId } = c.req.param();
  const body = await c.req.json<Partial<Task>>();

  if (!body.title?.trim()) {
    return c.json({ error: "title is required" }, 400);
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO tasks (
      id, board_id, title, description, status, priority, assignee,
      tdd_enabled, tdd_phase, mcps, skills, subagents, depends_on,
      parallel_group, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    boardId,
    body.title.trim(),
    body.description ?? "",
    body.status ?? "backlog",
    body.priority ?? "medium",
    body.assignee ?? "claude-code",
    body.tddEnabled !== false ? 1 : 0,
    body.tddPhase ?? "write_tests",
    JSON.stringify(body.mcps ?? []),
    JSON.stringify(body.skills ?? []),
    JSON.stringify(body.subagents ?? []),
    JSON.stringify(body.dependsOn ?? []),
    body.parallelGroup ?? null,
    now,
    now,
  );

  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Parameters<typeof rowToTask>[0];
  return c.json(rowToTask(task), 201);
});

// Update task (status drag-drop, field edits)
tasksRouter.patch("/tasks/:taskId", async (c) => {
  const { taskId } = c.req.param();
  const body = await c.req.json<Partial<Task>>();
  const db = getDb();

  const existing = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Parameters<typeof rowToTask>[0] | null;
  if (!existing) return c.json({ error: "not found" }, 404);

  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: unknown[] = [];

  const stringField = (col: string, val: unknown) => {
    if (val !== undefined) { updates.push(`${col} = ?`); values.push(val); }
  };

  stringField("title", body.title);
  stringField("description", body.description);
  stringField("status", body.status);
  stringField("priority", body.priority);
  stringField("assignee", body.assignee);
  stringField("tdd_phase", body.tddPhase);
  stringField("parallel_group", body.parallelGroup);
  stringField("active_form", body.activeForm);
  stringField("worktree_path", body.worktreePath);

  if (body.tddEnabled !== undefined) {
    updates.push("tdd_enabled = ?");
    values.push(body.tddEnabled ? 1 : 0);
  }
  if (body.mcps !== undefined) { updates.push("mcps = ?"); values.push(JSON.stringify(body.mcps)); }
  if (body.skills !== undefined) { updates.push("skills = ?"); values.push(JSON.stringify(body.skills)); }
  if (body.dependsOn !== undefined) { updates.push("depends_on = ?"); values.push(JSON.stringify(body.dependsOn)); }

  if (updates.length === 0) return c.json({ error: "no fields to update" }, 400);

  updates.push("updated_at = ?");
  values.push(now);
  values.push(taskId);

  db.query(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Parameters<typeof rowToTask>[0];
  return c.json(rowToTask(updated));
});

// Delete task
tasksRouter.delete("/tasks/:taskId", (c) => {
  const { taskId } = c.req.param();
  const db = getDb();
  db.query("DELETE FROM tasks WHERE id = ?").run(taskId);
  return c.json({ ok: true });
});

// SSE stream for live task activity (stub — real events come in Day 4)
tasksRouter.get("/tasks/:taskId/stream", (c) => {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("data: {\"type\":\"connected\"}\n\n"));
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
});
