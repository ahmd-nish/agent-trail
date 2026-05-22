import { Hono } from "hono";
import { getDb, rowToBoard } from "../db.ts";
import type { Board } from "../../../core/src/types/index.ts";

export const boardsRouter = new Hono();

boardsRouter.get("/", (c) => {
  const db = getDb();
  const rows = db.query("SELECT * FROM boards ORDER BY created_at DESC").all() as Parameters<typeof rowToBoard>[0][];
  return c.json(rows.map(rowToBoard));
});

boardsRouter.post("/", async (c) => {
  const body = await c.req.json<{ name: string; prdSource?: string }>();
  if (!body.name?.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.query(
    "INSERT INTO boards (id, name, prd_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, body.name.trim(), body.prdSource ?? null, now, now);

  const board = db.query("SELECT * FROM boards WHERE id = ?").get(id) as Parameters<typeof rowToBoard>[0];
  return c.json(rowToBoard(board), 201);
});

boardsRouter.delete("/:boardId", (c) => {
  const { boardId } = c.req.param();
  const db = getDb();
  db.query("DELETE FROM boards WHERE id = ?").run(boardId);
  return c.json({ ok: true });
});
