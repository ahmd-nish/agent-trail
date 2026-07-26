import { Hono } from "hono";
import { getDb } from "../db.ts";
import {
  buildQuestionsPrompt,
  buildPrdPrompt,
  parseAndRepairQuestions,
  validateSynthesizedPrd,
  type WizardAnswers,
  type WizardQuestion,
} from "../../../core/src/wizard/index.ts";
import { runIdeaLLM } from "../../../core/src/wizard/runner.ts";

// PRD_OPEN_SOURCE Phase-3+ addendum — "Idea → Guided plan → Test → Build" wizard.
//
// This router is deliberately dumb about the LLM: it delegates to
// `runIdeaLLM` which returns raw text; the wizard core parses + repairs it.
// Tests set AGENT_TRAIL_IDEA_MOCK to bypass claude.

export const ideasRouter = new Hono();

interface IdeaRow {
  id: string;
  board_id: string | null;
  idea_text: string;
  questions: string;
  answers: string;
  synthesized_prd: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToIdea(row: IdeaRow) {
  return {
    id: row.id,
    boardId: row.board_id,
    ideaText: row.idea_text,
    questions: JSON.parse(row.questions) as WizardQuestion[],
    answers: JSON.parse(row.answers) as WizardAnswers,
    synthesizedPrd: row.synthesized_prd,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// POST /api/ideas/start { idea: "..." }
//   → creates an ideas row, calls the LLM for the question set, persists,
//     and returns the full idea (id + questions + status).
ideasRouter.post("/ideas/start", async (c) => {
  const body = await c.req.json<{ idea?: string }>().catch(() => ({}));
  const idea = (body.idea ?? "").trim();
  if (!idea) return c.json({ error: "idea is required" }, 400);
  if (idea.length > 4000) return c.json({ error: "idea too long — max 4000 chars" }, 400);

  const db = getDb();
  const id = `idea-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // Insert first so a subsequent LLM failure doesn't lose the idea text.
  db.query(
    "INSERT INTO ideas (id, idea_text, status, created_at, updated_at) VALUES (?, ?, 'gathering', ?, ?)",
  ).run(id, idea, now, now);

  let questions: WizardQuestion[];
  try {
    const raw = await runIdeaLLM(buildQuestionsPrompt(idea));
    const parsed = parseAndRepairQuestions(raw);
    questions = parsed.questions;
  } catch (err) {
    db.query("UPDATE ideas SET status = 'error', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return c.json({ error: `wizard LLM failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  db.query("UPDATE ideas SET questions = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(questions), new Date().toISOString(), id,
  );

  const row = db.query("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow;
  return c.json(rowToIdea(row), 201);
});

// GET /api/ideas/:id — read the wizard state (used by the UI to resume).
ideasRouter.get("/ideas/:id", (c) => {
  const row = getDb().query("SELECT * FROM ideas WHERE id = ?").get(c.req.param("id")) as IdeaRow | null;
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(rowToIdea(row));
});

// POST /api/ideas/:id/answer { key: "frontend", value: "Next.js" | ["auth"], note?: "..." }
//   → records the answer. Idempotent — replays overwrite the prior answer.
ideasRouter.post("/ideas/:id/answer", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ key?: string; value?: string | string[]; note?: string }>().catch(() => ({}));
  if (!body.key) return c.json({ error: "key is required" }, 400);
  if (body.value === undefined || body.value === null) {
    return c.json({ error: "value is required" }, 400);
  }

  const db = getDb();
  const row = db.query("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow | null;
  if (!row) return c.json({ error: "idea not found" }, 404);
  if (row.status !== "gathering") return c.json({ error: `cannot answer in status '${row.status}'` }, 409);

  const questions = JSON.parse(row.questions) as WizardQuestion[];
  const knownKeys = new Set(questions.map((q) => q.key));
  if (!knownKeys.has(body.key)) {
    return c.json({ error: `unknown question key '${body.key}'` }, 400);
  }

  const answers = JSON.parse(row.answers) as WizardAnswers;
  answers[body.key] = { value: body.value, ...(body.note ? { note: body.note } : {}) };
  db.query("UPDATE ideas SET answers = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(answers), new Date().toISOString(), id,
  );
  const updated = db.query("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow;
  return c.json(rowToIdea(updated));
});

// POST /api/ideas/:id/synthesize-prd
//   → runs the second LLM call to convert (idea + answers) into a markdown PRD.
//     Marks the idea `ready` on success. The UI then hands the PRD to
//     /api/boards/plan to build the task graph.
ideasRouter.post("/ideas/:id/synthesize-prd", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db.query("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow | null;
  if (!row) return c.json({ error: "idea not found" }, 404);

  const questions = JSON.parse(row.questions) as WizardQuestion[];
  const answers   = JSON.parse(row.answers) as WizardAnswers;
  // Soft check: every question must have some answer. The UI enforces this
  // too; here we short-circuit so we don't burn LLM tokens on garbage input.
  const missing = questions.filter((q) => !answers[q.key]);
  if (missing.length > 0) {
    return c.json({ error: `unanswered questions: ${missing.map((q) => q.key).join(", ")}` }, 400);
  }

  let prd: string;
  try {
    prd = (await runIdeaLLM(buildPrdPrompt(row.idea_text, questions, answers))).trim();
  } catch (err) {
    return c.json({ error: `PRD synthesis failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
  const valid = validateSynthesizedPrd(prd);
  if (!valid.ok) return c.json({ error: valid.error }, 502);

  db.query(
    "UPDATE ideas SET synthesized_prd = ?, status = 'ready', updated_at = ? WHERE id = ?",
  ).run(prd, new Date().toISOString(), id);
  const updated = db.query("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow;
  return c.json(rowToIdea(updated));
});

// POST /api/ideas/:id/link-board { boardId }
//   → After the caller creates a board (via /api/boards/plan), they can link
//     the resulting board id back so we have a durable trail.
ideasRouter.post("/ideas/:id/link-board", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ boardId?: string }>().catch(() => ({}));
  if (!body.boardId) return c.json({ error: "boardId is required" }, 400);

  const db = getDb();
  const idea = db.query("SELECT id FROM ideas WHERE id = ?").get(id);
  if (!idea) return c.json({ error: "idea not found" }, 404);
  const board = db.query("SELECT id FROM boards WHERE id = ?").get(body.boardId);
  if (!board) return c.json({ error: "board not found" }, 404);

  db.query(
    "UPDATE ideas SET board_id = ?, status = 'done', updated_at = ? WHERE id = ?",
  ).run(body.boardId, new Date().toISOString(), id);
  const updated = db.query("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow;
  return c.json(rowToIdea(updated));
});
