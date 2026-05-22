import { Hono } from "hono";
import { getDb } from "../db.ts";
import { planFromPrd } from "../../core/src/planner/index.ts";
import type { Task } from "../../core/src/types/index.ts";

export const planRouter = new Hono();

/**
 * POST /api/boards/plan
 * Body: { prdText, name?, boardId?, dryRun? }
 * Runs the planner and optionally saves tasks to a board.
 */
planRouter.post("/plan", async (c) => {
  const body = await c.req.json<{
    prdText: string;
    name?: string;
    boardId?: string;
    dryRun?: boolean;
  }>();

  if (!body.prdText?.trim()) {
    return c.json({ error: "prdText is required" }, 400);
  }

  if (!body.boardId && !body.name?.trim()) {
    return c.json({ error: "Provide boardId to add to an existing board, or name to create a new one" }, 400);
  }

  const db = getDb();
  const now = new Date().toISOString();
  const dryRun = body.dryRun ?? false;

  // Resolve or create board
  let boardId = body.boardId ?? "";
  let boardName = body.name ?? "";

  if (boardId) {
    const existing = db.query("SELECT id, name FROM boards WHERE id = ?").get(boardId) as
      | { id: string; name: string }
      | null;
    if (!existing) return c.json({ error: `Board ${boardId} not found` }, 404);
    boardName = existing.name;
  } else if (!dryRun) {
    boardId = crypto.randomUUID();
    db.query("INSERT INTO boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      boardId,
      boardName.trim(),
      now,
      now,
    );
  } else {
    boardId = crypto.randomUUID(); // placeholder for dry run
  }

  // Run planner
  let result: Awaited<ReturnType<typeof planFromPrd>>;
  try {
    result = await planFromPrd(body.prdText.trim(), boardId);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  // Persist tasks (skip on dry run)
  if (!dryRun) {
    const insert = db.prepare(
      `INSERT INTO tasks
         (id, board_id, title, description, status, priority, assignee, tdd_enabled, tdd_phase,
          mcps, skills, subagents, depends_on, parallel_group, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const t of result.tasks) {
      insert.run(
        t.id, boardId, t.title, t.description, t.status, t.priority, t.assignee,
        t.tddEnabled ? 1 : 0, t.tddPhase,
        JSON.stringify(t.mcps), JSON.stringify(t.skills), JSON.stringify(t.subagents),
        JSON.stringify(t.dependsOn), t.parallelGroup, t.createdAt, t.updatedAt,
      );
    }
  }

  return c.json({
    board: dryRun ? null : { id: boardId, name: boardName },
    tasks: result.tasks as Task[],
    usage: result.usage,
    dryRun,
  });
});
