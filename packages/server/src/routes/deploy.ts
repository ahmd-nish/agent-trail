import { Hono } from "hono";
import { getDb } from "../db.ts";
import { runDeploy, type DeployTarget } from "../../../core/src/adapters/deploy.ts";

// PRD_OPEN_SOURCE §5.6 — deploy agent (human-gated).
//
//   GET    /api/boards/:id/deploy-targets                    — list
//   POST   /api/boards/:id/deploy-targets                    — create
//   DELETE /api/deploy-targets/:targetId                     — remove
//   POST   /api/boards/:id/deploy                            — kick a deploy
//     body: { targetName, autoConfirm?: false }
//     Default flow:
//       1. Insert a `deploys` row with status="pending"
//       2. Insert a `decision_tickets` row asking the user to confirm
//       3. Return { deployId, ticketId } — caller polls or waits on SSE
//     When the ticket is answered "yes"/"approve" via the existing
//     /api/decisions/:id/answer route, THAT handler dispatches the actual
//     shell command. See execution-manager? No — we do it here directly
//     via a small resumer so the deploy path stays isolated from the task
//     execution loop.

export const deployRouter = new Hono();

interface TargetRow {
  id: string; board_id: string; name: string; kind: string;
  command: string; healthcheck_url: string | null; rollback_command: string | null;
  working_dir: string | null; created_at: string; updated_at: string;
}
function rowToTarget(r: TargetRow) {
  return {
    id: r.id, boardId: r.board_id, name: r.name, kind: r.kind, command: r.command,
    healthcheckUrl: r.healthcheck_url, rollbackCommand: r.rollback_command,
    workingDir: r.working_dir, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ─── Deploy targets CRUD ─────────────────────────────────────────────────────

deployRouter.get("/boards/:boardId/deploy-targets", (c) => {
  const rows = getDb().query(
    "SELECT * FROM deploy_targets WHERE board_id = ? ORDER BY created_at ASC",
  ).all(c.req.param("boardId")) as TargetRow[];
  return c.json(rows.map(rowToTarget));
});

deployRouter.post("/boards/:boardId/deploy-targets", async (c) => {
  const { boardId } = c.req.param();
  const body = await c.req.json<{
    name?: string; command?: string; kind?: string;
    healthcheckUrl?: string | null; rollbackCommand?: string | null; workingDir?: string | null;
  }>().catch(() => ({}));
  if (!body.name?.trim() || !body.command?.trim()) {
    return c.json({ error: "name and command are required" }, 400);
  }
  const db = getDb();
  if (!db.query("SELECT 1 FROM boards WHERE id = ?").get(boardId)) {
    return c.json({ error: "board not found" }, 404);
  }
  const now = new Date().toISOString();
  const id = `dt-${crypto.randomUUID()}`;
  try {
    db.query(
      `INSERT INTO deploy_targets (id, board_id, name, kind, command, healthcheck_url, rollback_command, working_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, boardId, body.name.trim(), (body.kind ?? "shell").trim(), body.command.trim(),
          body.healthcheckUrl ?? null, body.rollbackCommand ?? null, body.workingDir ?? null, now, now);
  } catch (err) {
    return c.json({ error: `insert failed (duplicate name?): ${err instanceof Error ? err.message : String(err)}` }, 409);
  }
  const row = db.query("SELECT * FROM deploy_targets WHERE id = ?").get(id) as TargetRow;
  return c.json(rowToTarget(row), 201);
});

deployRouter.delete("/deploy-targets/:targetId", (c) => {
  const { targetId } = c.req.param();
  const db = getDb();
  const row = db.query("SELECT id FROM deploy_targets WHERE id = ?").get(targetId);
  if (!row) return c.json({ error: "not found" }, 404);
  db.query("DELETE FROM deploy_targets WHERE id = ?").run(targetId);
  return c.json({ ok: true });
});

// ─── Kick a deploy ───────────────────────────────────────────────────────────
// Two modes:
//   • default (autoConfirm=false): raise a decision ticket; deploy runs
//     after answer via the /confirm endpoint below.
//   • autoConfirm=true (CI / trusted flows): skip the ticket, run immediately.

deployRouter.post("/boards/:boardId/deploy", async (c) => {
  const { boardId } = c.req.param();
  const body = await c.req.json<{ targetName?: string; autoConfirm?: boolean }>().catch(() => ({}));
  if (!body.targetName?.trim()) return c.json({ error: "targetName is required" }, 400);

  const db = getDb();
  const target = db.query(
    "SELECT * FROM deploy_targets WHERE board_id = ? AND name = ?",
  ).get(boardId, body.targetName.trim()) as TargetRow | null;
  if (!target) return c.json({ error: "target not found on this board" }, 404);

  const now = new Date().toISOString();
  const deployId = `deploy-${crypto.randomUUID()}`;
  db.query(
    `INSERT INTO deploys (id, board_id, target_id, status, started_at) VALUES (?, ?, ?, 'pending', ?)`,
  ).run(deployId, boardId, target.id, now);

  if (body.autoConfirm) {
    // Fire-and-return: the deploy proceeds in the background. Caller can
    // poll GET /api/deploys/:id for status.
    void runDeployBackground(deployId, rowToTarget(target));
    return c.json({ deployId, status: "running", requiresConfirmation: false }, 202);
  }

  // Gated path: raise a decision ticket with the deploy metadata.
  const ticketId = crypto.randomUUID();
  const question = `Deploy to "${target.name}" (${target.kind})?`;
  const context = [
    `Command: ${target.command}`,
    target.working_dir ? `Working dir: ${target.working_dir}` : "",
    target.healthcheck_url ? `Healthcheck: ${target.healthcheck_url}` : "",
    target.rollback_command ? `Rollback: ${target.rollback_command}` : "",
    `Deploy id: ${deployId}`,
  ].filter(Boolean).join("\n");
  // decision_tickets requires task_id — deploys are board-scoped, so we
  // create a synthetic sentinel using board_id-as-task_id. The UI knows to
  // treat these specially by the question prefix. If a "deploy sentinel"
  // task doesn't yet exist for the board, we skip the ticket insert and
  // rely on the /deploys/:id/confirm endpoint the CLI hits directly.
  try {
    db.query(
      `INSERT INTO decision_tickets (id, task_id, execution_id, question, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ticketId, boardId, deployId, question, context, now);
    db.query("UPDATE deploys SET decision_ticket_id = ? WHERE id = ?").run(ticketId, deployId);
  } catch (err) {
    // Ticket insert can fail if task_id FK is strict; the deploy still
    // exists and can be confirmed via /deploys/:id/confirm.
    console.warn(`[deploy] ticket insert skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  return c.json({ deployId, ticketId, status: "pending", requiresConfirmation: true }, 201);
});

// Explicit CLI-facing confirm; also used when the user answers the ticket.
deployRouter.post("/deploys/:deployId/confirm", async (c) => {
  const { deployId } = c.req.param();
  const db = getDb();
  const deploy = db.query("SELECT * FROM deploys WHERE id = ?").get(deployId) as {
    id: string; target_id: string; status: string;
  } | null;
  if (!deploy) return c.json({ error: "deploy not found" }, 404);
  if (deploy.status !== "pending") {
    return c.json({ error: `deploy is ${deploy.status}, not pending` }, 409);
  }
  const target = db.query("SELECT * FROM deploy_targets WHERE id = ?").get(deploy.target_id) as TargetRow | null;
  if (!target) return c.json({ error: "target vanished" }, 500);

  // Move to running + run.
  db.query("UPDATE deploys SET status = 'running' WHERE id = ?").run(deployId);
  const result = await runDeploy(rowToTarget(target));
  const finishedAt = new Date().toISOString();
  db.query(
    `UPDATE deploys SET status = ?, command_output = ?, healthcheck_status = ?, rollback_output = ?, finished_at = ? WHERE id = ?`,
  ).run(
    result.ok ? "success" : result.status,
    result.commandOutput,
    result.healthcheckStatus ?? null,
    result.rollbackOutput ?? null,
    finishedAt,
    deployId,
  );
  return c.json({ deployId, ...result });
});

deployRouter.get("/deploys/:deployId", (c) => {
  const row = getDb().query("SELECT * FROM deploys WHERE id = ?").get(c.req.param("deployId"));
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

deployRouter.get("/boards/:boardId/deploys", (c) => {
  const rows = getDb().query(
    "SELECT * FROM deploys WHERE board_id = ? ORDER BY started_at DESC LIMIT 50",
  ).all(c.req.param("boardId"));
  return c.json(rows);
});

// ─── Internal: background runner for autoConfirm mode ────────────────────────

async function runDeployBackground(deployId: string, target: DeployTarget): Promise<void> {
  const db = getDb();
  db.query("UPDATE deploys SET status = 'running' WHERE id = ?").run(deployId);
  try {
    const result = await runDeploy(target);
    const finishedAt = new Date().toISOString();
    db.query(
      `UPDATE deploys SET status = ?, command_output = ?, healthcheck_status = ?, rollback_output = ?, finished_at = ? WHERE id = ?`,
    ).run(
      result.ok ? "success" : result.status,
      result.commandOutput,
      result.healthcheckStatus ?? null,
      result.rollbackOutput ?? null,
      finishedAt,
      deployId,
    );
  } catch (err) {
    db.query(
      `UPDATE deploys SET status = 'command_failed', command_output = ?, finished_at = ? WHERE id = ?`,
    ).run(`deploy threw: ${err instanceof Error ? err.message : String(err)}`, new Date().toISOString(), deployId);
  }
}
