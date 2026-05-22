import { Hono } from "hono";
import { getDb } from "../db.ts";
import { executionManager } from "../execution-manager.ts";

export const decisionsRouter = new Hono();

// List open decision tickets for a task
decisionsRouter.get("/tasks/:taskId/decisions", (c) => {
  const { taskId } = c.req.param();
  const rows = getDb()
    .query(
      "SELECT * FROM decision_tickets WHERE task_id = ? ORDER BY created_at DESC",
    )
    .all(taskId);
  return c.json(rows);
});

// Answer a decision ticket and resume execution
decisionsRouter.post("/decisions/:ticketId/answer", async (c) => {
  const { ticketId } = c.req.param();
  const { answer } = await c.req.json<{ answer: string }>();

  if (!answer?.trim()) return c.json({ error: "answer is required" }, 400);

  const db = getDb();
  const ticket = db
    .query("SELECT * FROM decision_tickets WHERE id = ?")
    .get(ticketId) as {
    id: string;
    task_id: string;
    execution_id: string;
    question: string;
    context: string | null;
    answer: string | null;
    answered_at: string | null;
    created_at: string;
  } | null;

  if (!ticket) return c.json({ error: "ticket not found" }, 404);
  if (ticket.answer !== null) return c.json({ error: "already answered" }, 409);

  const now = new Date().toISOString();
  db.query(
    "UPDATE decision_tickets SET answer = ?, answered_at = ? WHERE id = ?",
  ).run(answer.trim(), now, ticketId);

  // Resume the task
  const result = await executionManager.resume(ticket.task_id, ticket.question, answer.trim());
  if ("error" in result) return c.json({ error: result.error }, 409);

  return c.json({ ok: true, executionId: result.executionId });
});
