import { Hono } from "hono";
import { getDb } from "../db.ts";

export const artifactsRouter = new Hono();

artifactsRouter.get("/tasks/:taskId/artifacts", (c) => {
  const db = getDb();
  const rows = db
    .query("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC")
    .all(c.req.param("taskId"));
  return c.json(rows);
});

artifactsRouter.get("/artifacts/:id", (c) => {
  const db = getDb();
  const row = db.query("SELECT * FROM artifacts WHERE id = ?").get(c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});
