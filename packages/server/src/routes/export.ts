import { Hono } from "hono";
import { getDb } from "../db.ts";

export const exportRouter = new Hono();

exportRouter.get("/boards/:boardId/export", (c) => {
  const db = getDb();
  const boardId = c.req.param("boardId");

  const board = db.query("SELECT * FROM boards WHERE id = ?").get(boardId);
  if (!board) return c.json({ error: "Board not found" }, 404);

  const tasks = db
    .query("SELECT * FROM tasks WHERE board_id = ? ORDER BY created_at")
    .all(boardId);

  const executions = db
    .query(
      `SELECT * FROM executions
       WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)
       ORDER BY started_at`,
    )
    .all(boardId);

  const artifacts = db
    .query(
      `SELECT * FROM artifacts
       WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)
       ORDER BY created_at`,
    )
    .all(boardId);

  return c.json({
    board,
    tasks,
    executions,
    artifacts,
    exportedAt: new Date().toISOString(),
  });
});
