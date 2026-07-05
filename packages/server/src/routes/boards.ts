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
    "INSERT INTO boards (id, name, prd_source, permission_mode, implementation_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, body.name.trim(), body.prdSource ?? null, DEFAULT_PERMISSION_MODE, implDir, now, now);

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
  const result = await executionManager.runBoard(boardId);
  if ("error" in result) return c.json({ error: result.error }, 400);
  return c.json(result);
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
