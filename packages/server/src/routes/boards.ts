import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getDb, rowToBoard, listBoardEnv, setBoardEnv, deleteBoardEnv } from "../db.ts";
import { executionManager } from "../execution-manager.ts";
import type { Board } from "../../../core/src/types/index.ts";
import { DEFAULT_PERMISSION_MODE } from "../../../core/src/types/index.ts";
import type { BlockerInfo } from "../execution-manager.ts";

/**
 * Build a per-board implementation directory under ~/agent-trail-runs/.
 * The directory is created eagerly so Claude has somewhere to write on first run.
 */
function defaultImplementationDir(boardName: string): string {
  const slug = boardName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "board";
  const path = join(homedir(), "agent-trail-runs", slug);
  try {
    mkdirSync(path, { recursive: true });
  } catch (err) {
    console.warn(`[boards] could not create impl dir ${path}:`, err);
  }
  return path;
}

export const boardsRouter = new Hono();

boardsRouter.get("/", (c) => {
  const db = getDb();
  const rows = db.query("SELECT * FROM boards ORDER BY created_at DESC").all() as Parameters<typeof rowToBoard>[0][];
  return c.json(rows.map(rowToBoard));
});

boardsRouter.post("/", async (c) => {
  const body = await c.req.json<{ name: string; prdSource?: string; implementationDir?: string }>();
  if (!body.name?.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const implDir = body.implementationDir?.trim()
    ? resolve(body.implementationDir.trim())
    : defaultImplementationDir(body.name.trim());

  db.query(
    "INSERT INTO boards (id, name, prd_source, permission_mode, implementation_dir, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, body.name.trim(), body.prdSource ?? null, DEFAULT_PERMISSION_MODE, implDir, now, now, now);

  const board = db.query("SELECT * FROM boards WHERE id = ?").get(id) as Parameters<typeof rowToBoard>[0];
  return c.json(rowToBoard(board), 201);
});

const VALID_PERMISSION_MODES = new Set(["default", "acceptEdits", "bypassPermissions", "plan"]);

boardsRouter.patch("/:boardId", async (c) => {
  const { boardId } = c.req.param();
  const body = await c.req.json<{
    webhookUrl?: string | null;
    defaultModel?: string | null;
    defaultAssignee?: string;
    defaultReviewKind?: string;
    permissionMode?: string;
    implementationDir?: string | null;
    devCommand?: string | null;
    devPort?: number | null;
    executionTimeoutMs?: number;
    // PRD_OPEN_SOURCE 2.3 — per-board budgets. 0 disables the cap.
    executionCostCapUsd?: number;
    executionTokenCap?: number;
    // PRD_OPEN_SOURCE 2.5 / 2.6
    autoCommit?: boolean;
    autoPr?: boolean;
    commitStyle?: string;
  }>();
  const db = getDb();
  const now = new Date().toISOString();
  const updates: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];

  if ("webhookUrl" in body) { updates.push("webhook_url = ?"); values.push(body.webhookUrl ?? null); }
  if ("defaultModel" in body) { updates.push("default_model = ?"); values.push(body.defaultModel ?? null); }
  if ("defaultAssignee" in body) { updates.push("default_assignee = ?"); values.push(body.defaultAssignee); }
  if ("defaultReviewKind" in body) { updates.push("default_review_kind = ?"); values.push(body.defaultReviewKind); }
  if ("permissionMode" in body) {
    if (!body.permissionMode || !VALID_PERMISSION_MODES.has(body.permissionMode)) {
      return c.json({ error: `permissionMode must be one of ${[...VALID_PERMISSION_MODES].join(", ")}` }, 400);
    }
    updates.push("permission_mode = ?");
    values.push(body.permissionMode);
  }
  if ("devCommand" in body) {
    updates.push("dev_command = ?");
    values.push(body.devCommand?.trim() || null);
  }
  if ("devPort" in body) {
    updates.push("dev_port = ?");
    values.push(body.devPort ?? null);
  }
  if ("executionTimeoutMs" in body) {
    const v = body.executionTimeoutMs;
    // Sane bounds: 30s floor (anything tighter just thrashes), 4h ceiling (longer means the user wants a different tool).
    if (typeof v !== "number" || !Number.isFinite(v) || v < 30_000 || v > 14_400_000) {
      return c.json({ error: "executionTimeoutMs must be a number between 30000 and 14400000" }, 400);
    }
    updates.push("execution_timeout_ms = ?");
    values.push(v);
  }
  if ("executionCostCapUsd" in body) {
    const v = body.executionCostCapUsd;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return c.json({ error: "executionCostCapUsd must be a non-negative number" }, 400);
    }
    updates.push("execution_cost_cap_usd = ?");
    values.push(v);
  }
  if ("executionTokenCap" in body) {
    const v = body.executionTokenCap;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return c.json({ error: "executionTokenCap must be a non-negative number" }, 400);
    }
    updates.push("execution_token_cap = ?");
    values.push(v);
  }
  if ("autoCommit" in body) {
    updates.push("auto_commit = ?");
    values.push(body.autoCommit ? 1 : 0);
  }
  if ("autoPr" in body) {
    updates.push("auto_pr = ?");
    values.push(body.autoPr ? 1 : 0);
  }
  if ("commitStyle" in body) {
    updates.push("commit_style = ?");
    values.push(body.commitStyle ?? "conventional");
  }
  if ("implementationDir" in body) {
    const dir = body.implementationDir?.trim();
    if (dir) {
      const abs = resolve(dir);
      try { mkdirSync(abs, { recursive: true }); } catch (err) {
        console.warn(`[boards] could not create impl dir ${abs}:`, err);
      }
      updates.push("implementation_dir = ?");
      values.push(abs);
    } else {
      updates.push("implementation_dir = ?");
      values.push(null);
    }
  }

  values.push(boardId);
  db.query(`UPDATE boards SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  const row = db.query("SELECT * FROM boards WHERE id = ?").get(boardId) as Parameters<typeof rowToBoard>[0];
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(rowToBoard(row));
});

boardsRouter.post("/:boardId/run", async (c) => {
  const { boardId } = c.req.param();
  // §C plan-review gate — refuse to start a batch run when the plan hasn't
  // been approved yet. Single-task /execute is gated in tasks.ts.
  const board = getDb().query("SELECT approved_at FROM boards WHERE id = ?").get(boardId) as { approved_at: string | null } | null;
  if (!board) return c.json({ error: "board not found" }, 404);
  if (!board.approved_at) return c.json({ error: "board pending plan approval — POST /api/boards/:id/approve first" }, 403);
  const result = await executionManager.runBoard(boardId);
  if ("error" in result) return c.json({ error: result.error }, 400);
  return c.json(result);
});

// §C plan-review approval. Idempotent — approving an already-approved board
// is a no-op; the returned board reflects the current state either way.
boardsRouter.post("/:boardId/approve", (c) => {
  const { boardId } = c.req.param();
  const db = getDb();
  const board = db.query("SELECT * FROM boards WHERE id = ?").get(boardId) as Parameters<typeof rowToBoard>[0] | null;
  if (!board) return c.json({ error: "board not found" }, 404);
  if (!board.approved_at) {
    const now = new Date().toISOString();
    db.query("UPDATE boards SET approved_at = ?, updated_at = ? WHERE id = ?").run(now, now, boardId);
  }
  const updated = db.query("SELECT * FROM boards WHERE id = ?").get(boardId) as Parameters<typeof rowToBoard>[0];
  return c.json(rowToBoard(updated));
});

boardsRouter.get("/:boardId/running", (c) => {
  const { boardId } = c.req.param();
  return c.json({
    running: executionManager.isBoardRunning(boardId),
    activeCount: executionManager.concurrentCount,
    queuedCount: executionManager.queuedCount,
    maxConcurrent: executionManager.maxConcurrent,
  });
});

boardsRouter.delete("/:boardId", (c) => {
  const { boardId } = c.req.param();
  const db = getDb();
  db.query("DELETE FROM boards WHERE id = ?").run(boardId);
  return c.json({ ok: true });
});

boardsRouter.post("/:boardId/run-scope", async (c) => {
  const { boardId } = c.req.param();
  const body = await c.req.json<{ type: "epic" | "sprint"; name: string }>();
  if (!body.type || !body.name?.trim()) {
    return c.json({ error: "type and name are required" }, 400);
  }
  const result = await executionManager.runScope(boardId, body.type, body.name.trim());
  if ("error" in result) return c.json({ error: result.error }, 400);
  return c.json(result);
});

// PRD_OPEN_SOURCE §4.6 — token/cost dashboard. Per-tier breakdown across
// every execution on the board + "vs naive baseline" delta (what the board
// would have cost if every task ran on Sonnet). Powers the top-of-board
// cost card and any future CI budgets.
import { PRICING, costForTier } from "../../../core/src/planner/pricing.ts";
import type { ModelTier } from "../../../core/src/types/index.ts";

boardsRouter.get("/:boardId/cost", (c) => {
  const { boardId } = c.req.param();
  const rows = getDb().query(`
    SELECT
      COALESCE(t.model_tier, 'sonnet')            AS tier,
      COALESCE(SUM(e.total_input_tokens), 0)      AS input_tokens,
      COALESCE(SUM(e.total_output_tokens), 0)     AS output_tokens,
      COUNT(e.id)                                 AS executions
    FROM tasks t
    LEFT JOIN executions e
      ON e.task_id = t.id
     AND e.status IN ('completed', 'failed', 'awaiting_human')
    WHERE t.board_id = ?
    GROUP BY tier
  `).all(boardId) as Array<{ tier: string; input_tokens: number; output_tokens: number; executions: number }>;

  const byTier = rows.map((r) => ({
    tier: r.tier as ModelTier,
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    executions: Number(r.executions ?? 0),
    usd: Number(costForTier(r.tier as ModelTier, Number(r.input_tokens ?? 0), Number(r.output_tokens ?? 0)).toFixed(4)),
  }));

  const totalInput  = byTier.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutput = byTier.reduce((s, r) => s + r.outputTokens, 0);
  const totalUsd    = byTier.reduce((s, r) => s + r.usd, 0);

  // "Naive baseline" = all traffic priced at Sonnet. Savings > 0 when we
  // downshifted anything to Haiku; savings < 0 when Opus escalations pulled
  // the bill up.
  const baselineUsd = costForTier("sonnet", totalInput, totalOutput);
  const savingsUsd  = baselineUsd - totalUsd;

  return c.json({
    boardId,
    byTier,
    totals: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      usd: Number(totalUsd.toFixed(4)),
      executions: byTier.reduce((s, r) => s + r.executions, 0),
    },
    baseline: {
      description: "cost if every task ran on Sonnet",
      usd: Number(baselineUsd.toFixed(4)),
      savingsUsd: Number(savingsUsd.toFixed(4)),
      savingsPct: baselineUsd > 0 ? Number(((savingsUsd / baselineUsd) * 100).toFixed(1)) : 0,
    },
    pricing: PRICING,
  });
});

// PRD_OPEN_SOURCE §5.5 — loop observability. Per-task counters (iterations,
// escalations, thrash tickets, iterations-to-green) + board aggregates so
// the UI can show "loop 2/5, cost $0.12" and CI can watch escalation rates.
boardsRouter.get("/:boardId/loop-metrics", (c) => {
  const { boardId } = c.req.param();
  const db = getDb();
  const tasks = db.query(
    "SELECT id, title, status, model_tier, failed_verify_count, created_at FROM tasks WHERE board_id = ?",
  ).all(boardId) as Array<{
    id: string; title: string; status: string; model_tier: string | null;
    failed_verify_count: number | null; created_at: string;
  }>;

  const perTask = tasks.map((t) => {
    const verifyRuns = db.query(
      "SELECT COUNT(*) AS n FROM executions WHERE task_id = ? AND tdd_phase = 'verify_tests'",
    ).get(t.id) as { n: number };
    const verifyFailures = db.query(
      "SELECT COUNT(*) AS n FROM executions WHERE task_id = ? AND tdd_phase = 'verify_tests' AND status = 'failed'",
    ).get(t.id) as { n: number };
    const iterations = (db.query(
      "SELECT COUNT(*) AS n FROM iteration_memories WHERE task_id = ?",
    ).get(t.id) as { n: number }).n;
    const thrashTickets = (db.query(
      "SELECT COUNT(*) AS n FROM decision_tickets WHERE task_id = ? AND question LIKE '%thrashing%'",
    ).get(t.id) as { n: number }).n;
    const cost = (db.query(
      `SELECT COALESCE(SUM(total_input_tokens), 0) AS in_toks,
              COALESCE(SUM(total_output_tokens), 0) AS out_toks
       FROM executions WHERE task_id = ?`,
    ).get(t.id) as { in_toks: number; out_toks: number });
    const firstGreen = db.query(
      `SELECT MIN(finished_at) AS at FROM executions
       WHERE task_id = ? AND tdd_phase = 'verify_tests' AND status = 'completed'`,
    ).get(t.id) as { at: string | null };
    const timeToGreenMs = firstGreen?.at
      ? Math.max(0, new Date(firstGreen.at).getTime() - new Date(t.created_at).getTime())
      : null;

    return {
      taskId: t.id,
      title: t.title,
      status: t.status,
      currentTier: t.model_tier ?? "sonnet",
      iterationsRecorded: iterations,
      verifyRuns: verifyRuns.n,
      verifyFailures: verifyFailures.n,
      failedVerifyCount: t.failed_verify_count ?? 0,
      thrashTickets,
      inputTokens: cost.in_toks,
      outputTokens: cost.out_toks,
      timeToFirstGreenMs: timeToGreenMs,
    };
  });

  const completed = perTask.filter((p) => p.status === "in_review" || p.status === "done");
  const medianTimeToGreen = median(
    completed.map((p) => p.timeToFirstGreenMs).filter((v): v is number => v != null),
  );
  const escalatedTasks = perTask.filter((p) => p.currentTier === "opus").length;

  return c.json({
    boardId,
    perTask,
    aggregates: {
      totalTasks: perTask.length,
      completedTasks: completed.length,
      escalatedToOpus: escalatedTasks,
      thrashTicketsTotal: perTask.reduce((s, p) => s + p.thrashTickets, 0),
      iterationsTotal: perTask.reduce((s, p) => s + p.iterationsRecorded, 0),
      medianTimeToFirstGreenMs: medianTimeToGreen,
    },
  });
});

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

boardsRouter.get("/:boardId/metrics", (c) => {
  const { boardId } = c.req.param();
  const db = getDb();
  const rows = db.query(`
    SELECT
      t.id          AS task_id,
      t.title,
      t.epic,
      t.sprint,
      t.status,
      t.priority,
      COALESCE(SUM(e.duration_ms), 0)         AS total_duration_ms,
      COALESCE(SUM(e.total_input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(e.total_output_tokens), 0) AS total_output_tokens,
      COUNT(e.id)                             AS execution_count
    FROM tasks t
    LEFT JOIN executions e ON e.task_id = t.id AND e.status IN ('completed','failed')
    WHERE t.board_id = ?
    GROUP BY t.id
    ORDER BY (t.epic IS NULL), t.epic, (t.sprint IS NULL), t.sprint, t.title
  `).all(boardId);
  return c.json(rows);
});

// ─── Board env routes (Phase 3b) ─────────────────────────────────────────────
// Encrypted env vars used for {{env.X}} substitution in test cases.
// Values are stored encrypted (AES-256-GCM); see packages/core/src/crypto/secrets.ts.

// Quick guard: confirm the board exists before any env mutation.
function boardExists(boardId: string): boolean {
  return !!getDb().query("SELECT 1 FROM boards WHERE id = ?").get(boardId);
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** List env entries. Pass ?reveal=1 to get decrypted plaintext values. */
boardsRouter.get("/:boardId/env", (c) => {
  const { boardId } = c.req.param();
  if (!boardExists(boardId)) return c.json({ error: "Board not found" }, 404);
  const reveal = c.req.query("reveal") === "1";
  return c.json({ entries: listBoardEnv(boardId, reveal), revealed: reveal });
});

/** Upsert one or more env entries. Body: `{ entries: [{key, value}, ...] }`. */
boardsRouter.put("/:boardId/env", async (c) => {
  const { boardId } = c.req.param();
  if (!boardExists(boardId)) return c.json({ error: "Board not found" }, 404);
  const body = await c.req.json<{ entries: Array<{ key: string; value: string }> }>().catch(() => null);
  if (!body || !Array.isArray(body.entries)) {
    return c.json({ error: "Body must be { entries: [{key, value}, ...] }" }, 400);
  }
  const errors: string[] = [];
  for (const e of body.entries) {
    if (!e?.key || typeof e.key !== "string") { errors.push(`missing key`); continue; }
    if (!KEY_PATTERN.test(e.key))             { errors.push(`invalid key "${e.key}" (use [A-Za-z_][A-Za-z0-9_]*)`); continue; }
    if (typeof e.value !== "string")          { errors.push(`value for "${e.key}" must be a string`); continue; }
    setBoardEnv(boardId, e.key, e.value);
  }
  if (errors.length > 0) return c.json({ ok: false, errors }, 400);
  return c.json({ ok: true, count: body.entries.length });
});

/** Delete a single env entry by key. */
boardsRouter.delete("/:boardId/env/:key", (c) => {
  const { boardId, key } = c.req.param();
  if (!boardExists(boardId)) return c.json({ error: "Board not found" }, 404);
  const removed = deleteBoardEnv(boardId, decodeURIComponent(key));
  return c.json({ ok: removed });
});
