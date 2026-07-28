import { Hono } from "hono";
import { basename } from "node:path";
import { getDb } from "../db.ts";
import { executionManager } from "../execution-manager.ts";
import { appendDecision, detectAuthor } from "../../../core/src/context/store.ts";
import { resolveProjectRoot } from "../../../core/src/storage/paths.ts";
import { append as appendKnowledge } from "../../../core/src/knowledge/store.ts";

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

  // PRD 3.3 — every ask_human answer auto-appends to context/decisions.md.
  // This is the team's durable ruling: any future agent execution that loads
  // the L0 constitution (PRD 3.4) will inherit it. Best-effort — never block
  // the resume on a filesystem hiccup.
  const taskRow = db
    .query("SELECT title FROM tasks WHERE id = ?")
    .get(ticket.task_id) as { title: string } | null;
  const root = resolveProjectRoot();
  try {
    appendDecision(root, {
      taskTitle: taskRow?.title ?? "unknown task",
      question: ticket.question,
      answer: answer.trim(),
    });
  } catch (err) {
    console.warn(
      `[decisions] failed to append decisions.md: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // knowledgelayer §4.1 — same decision, event-log form. Deterministic
  // projections (fold to constitution.md, risk index, retrieval scoring)
  // consume this instead of parsing markdown.
  try {
    const author = detectAuthor(root);
    appendKnowledge(db, {
      workspaceId: "local",
      projectId: basename(root) || "local",
      actorKind: "human",
      actorId: author,
      actorName: author,
      taskId: ticket.task_id,
      executionId: ticket.execution_id,
      type: "decision",
      scope: "project",
      subject: `${taskRow?.title ?? "unknown task"} — ${ticket.question.trim().slice(0, 120)}`,
      body: answer.trim(),
      paths: [],
      confidence: "ruling",
      supersedes: null,
    });
  } catch (err) {
    console.warn(
      `[decisions] failed to write knowledge event: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Resume the task
  const result = await executionManager.resume(ticket.task_id, ticket.question, answer.trim());
  if ("error" in result) return c.json({ error: result.error }, 409);

  return c.json({ ok: true, executionId: result.executionId });
});
