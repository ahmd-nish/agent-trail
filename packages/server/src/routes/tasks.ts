import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, rowToTask, recordTestCaseRun, getTestCaseTrend } from "../db.ts";
import { runTests, runCommand } from "../../../core/src/adapters/test-runner.ts";
import { resolveProjectRoot } from "../../../core/src/storage/paths.ts";
import type { Task, TaskStatus, Priority, AgentKind, Guardrail } from "../../../core/src/types/index.ts";

const REPO_ROOT = resolveProjectRoot();

export const tasksRouter = new Hono();

// List tasks for a board
tasksRouter.get("/boards/:boardId/tasks", (c) => {
  const { boardId } = c.req.param();
  const db = getDb();
  const rows = db
    .query("SELECT * FROM tasks WHERE board_id = ? ORDER BY created_at ASC")
    .all(boardId) as Parameters<typeof rowToTask>[0][];
  return c.json(rows.map(rowToTask));
});

// Create task
tasksRouter.post("/boards/:boardId/tasks", async (c) => {
  const { boardId } = c.req.param();
  const body = await c.req.json<Partial<Task>>();

  if (!body.title?.trim()) {
    return c.json({ error: "title is required" }, 400);
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Apply board-level defaults for fields not explicitly provided
  const boardRow = db.query("SELECT default_model, default_assignee, default_review_kind FROM boards WHERE id = ?").get(boardId) as
    { default_model: string | null; default_assignee: string | null; default_review_kind: string | null } | null;

  const modelTier = body.modelTier
    ?? (body.tddEnabled === false ? "haiku" : "sonnet");
  db.query(`
    INSERT INTO tasks (
      id, board_id, title, description, status, priority, assignee,
      tdd_enabled, tdd_phase, mcps, skills, subagents, depends_on,
      parallel_group, success_criteria, guardrails, epic, sprint,
      review_kind, reviewer, additional_prompt, model, model_tier, component,
      external_dependencies, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    boardId,
    body.title.trim(),
    body.description ?? "",
    body.status ?? "backlog",
    body.priority ?? "medium",
    body.assignee ?? boardRow?.default_assignee ?? "claude-code",
    body.tddEnabled !== false ? 1 : 0,
    body.tddPhase ?? "write_tests",
    JSON.stringify(body.mcps ?? []),
    JSON.stringify(body.skills ?? []),
    JSON.stringify(body.subagents ?? []),
    JSON.stringify(body.dependsOn ?? []),
    body.parallelGroup ?? null,
    JSON.stringify(body.successCriteria ?? []),
    JSON.stringify(body.guardrails ?? []),
    body.epic ?? null,
    body.sprint ?? null,
    body.reviewKind ?? boardRow?.default_review_kind ?? "none",
    body.reviewer ?? null,
    body.additionalPrompt ?? null,
    body.model ?? boardRow?.default_model ?? null,
    modelTier,
    body.component ?? null,
    JSON.stringify(body.externalDependencies ?? []),
    now,
    now,
  );

  // testCases on create — accepted so agents (and E2E tests) can seed a task
  // with its verification cases in one shot instead of a second PATCH.
  if (body.testCases !== undefined) {
    db.query("UPDATE tasks SET test_cases = ? WHERE id = ?").run(JSON.stringify(body.testCases), id);
  }

  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Parameters<typeof rowToTask>[0];
  return c.json(rowToTask(task), 201);
});

// Update task (status drag-drop, field edits)
tasksRouter.patch("/tasks/:taskId", async (c) => {
  const { taskId } = c.req.param();
  const body = await c.req.json<Partial<Task>>();
  const db = getDb();

  const existing = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Parameters<typeof rowToTask>[0] | null;
  if (!existing) return c.json({ error: "not found" }, 404);

  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: unknown[] = [];

  const stringField = (col: string, val: unknown) => {
    if (val !== undefined) { updates.push(`${col} = ?`); values.push(val); }
  };

  stringField("title", body.title);
  stringField("description", body.description);
  stringField("status", body.status);
  stringField("priority", body.priority);
  stringField("assignee", body.assignee);
  stringField("tdd_phase", body.tddPhase);
  stringField("parallel_group", body.parallelGroup);
  stringField("active_form", body.activeForm);
  stringField("worktree_path", body.worktreePath);

  if (body.tddEnabled !== undefined) {
    updates.push("tdd_enabled = ?");
    values.push(body.tddEnabled ? 1 : 0);
  }
  if (body.mcps !== undefined) { updates.push("mcps = ?"); values.push(JSON.stringify(body.mcps)); }
  if (body.skills !== undefined) { updates.push("skills = ?"); values.push(JSON.stringify(body.skills)); }
  if (body.subagents !== undefined) { updates.push("subagents = ?"); values.push(JSON.stringify(body.subagents)); }
  if (body.dependsOn !== undefined) { updates.push("depends_on = ?"); values.push(JSON.stringify(body.dependsOn)); }
  if (body.successCriteria !== undefined) { updates.push("success_criteria = ?"); values.push(JSON.stringify(body.successCriteria)); }
  if (body.guardrails !== undefined) { updates.push("guardrails = ?"); values.push(JSON.stringify(body.guardrails)); }
  if (body.externalDependencies !== undefined) { updates.push("external_dependencies = ?"); values.push(JSON.stringify(body.externalDependencies)); }
  if (body.testCases !== undefined) { updates.push("test_cases = ?"); values.push(JSON.stringify(body.testCases)); }
  stringField("epic", body.epic);
  stringField("sprint", body.sprint);
  stringField("review_kind", body.reviewKind);
  stringField("reviewer", body.reviewer);
  stringField("additional_prompt", body.additionalPrompt);
  stringField("model", body.model);
  if (body.modelTier !== undefined) {
    if (body.modelTier !== null && !["haiku", "sonnet", "opus"].includes(body.modelTier)) {
      return c.json({ error: "modelTier must be haiku, sonnet, opus, or null" }, 400);
    }
    updates.push("model_tier = ?");
    values.push(body.modelTier);
  }
  stringField("component", body.component);

  if (updates.length === 0) return c.json({ error: "no fields to update" }, 400);

  updates.push("updated_at = ?");
  values.push(now);
  values.push(taskId);

  db.query(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Parameters<typeof rowToTask>[0];
  return c.json(rowToTask(updated));
});

// Run test suite for a task and return output
tasksRouter.post("/tasks/:taskId/test", async (c) => {
  const { taskId } = c.req.param();
  const body = await c.req.json<{ filter?: string }>().catch(() => ({}));
  const db = getDb();
  const row = db.query(`
    SELECT t.worktree_path, b.implementation_dir
    FROM tasks t LEFT JOIN boards b ON t.board_id = b.id
    WHERE t.id = ?
  `).get(taskId) as { worktree_path: string | null; implementation_dir: string | null } | null;
  if (!row) return c.json({ error: "Task not found" }, 404);

  // Prefer the cwd Claude actually wrote in (worktree_path), then the board's
  // implementation_dir, then REPO_ROOT as a last-resort fallback.
  const cwd = row.worktree_path ?? row.implementation_dir ?? REPO_ROOT;
  const usedFallbackCwd = !row.worktree_path && !row.implementation_dir;
  const result = await runTests(cwd, body.filter);
  return c.json({ ...result, usedFallbackCwd });
});

// Proxy an HTTP request and return response (for API testing).
// timeoutMs is clamped to [100, 120_000] (30 s default) to prevent hung
// endpoints from holding the UI run open forever.
const DEFAULT_API_REQUEST_TIMEOUT_MS = 30_000;
const MAX_API_REQUEST_TIMEOUT_MS = 120_000;

tasksRouter.post("/tasks/:taskId/api-request", async (c) => {
  const body = await c.req.json<{
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }>();
  if (!body.url?.trim()) return c.json({ error: "url is required" }, 400);

  const requestedTimeout = Number(body.timeoutMs ?? DEFAULT_API_REQUEST_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(100, Math.min(MAX_API_REQUEST_TIMEOUT_MS, requestedTimeout))
    : DEFAULT_API_REQUEST_TIMEOUT_MS;

  const start = Date.now();
  try {
    const init: RequestInit = {
      method: body.method ?? "GET",
      headers: body.headers ?? {},
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body.body && !["GET", "HEAD"].includes((body.method ?? "GET").toUpperCase())) {
      init.body = body.body;
    }
    const res = await fetch(body.url.trim(), init);
    const responseBody = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return c.json({ status: res.status, statusText: res.statusText, headers, body: responseBody, durationMs: Date.now() - start });
  } catch (err) {
    // Distinguish timeout from other errors so the UI can render it cleanly.
    const isTimeout =
      err instanceof DOMException && err.name === "TimeoutError"
      || (err instanceof Error && err.name === "AbortError")
      || (err instanceof Error && /timeout/i.test(err.message));
    if (isTimeout) {
      return c.json(
        { error: `Request timed out after ${timeoutMs}ms`, durationMs: Date.now() - start, timedOut: true },
        408,
      );
    }
    return c.json({ error: String(err), durationMs: Date.now() - start });
  }
});

// Run an arbitrary shell command in the task's working directory
tasksRouter.post("/tasks/:taskId/custom-run", async (c) => {
  const { taskId } = c.req.param();
  const body = await c.req.json<{ command: string }>();
  if (!body.command?.trim()) return c.json({ error: "command is required" }, 400);
  const db = getDb();
  const row = db.query("SELECT worktree_path FROM tasks WHERE id = ?").get(taskId) as { worktree_path: string | null } | null;
  if (!row) return c.json({ error: "Task not found" }, 404);
  const cwd = row.worktree_path ?? REPO_ROOT;
  const result = await runCommand(body.command.trim(), cwd);
  return c.json(result);
});

// Discover likely base URLs from the task's worktree
tasksRouter.get("/tasks/:taskId/discover-urls", (c) => {
  const { taskId } = c.req.param();
  const db = getDb();
  const row = db.query("SELECT worktree_path FROM tasks WHERE id = ?").get(taskId) as { worktree_path: string | null } | null;
  if (!row) return c.json({ suggestions: [] });

  const cwd = row.worktree_path ?? REPO_ROOT;
  const suggestions: Array<{ label: string; url: string; source: string }> = [];
  const seen = new Set<string>();

  function add(url: string, label: string, source: string) {
    const norm = url.replace(/\/$/, "");
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    suggestions.push({ url: norm, label, source });
  }

  // 1. Parse .env files for PORT / URL vars
  for (const envFile of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    const p = join(cwd, envFile);
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, "utf-8").split("\n");
      for (const line of lines) {
        const m = line.match(/^([A-Z_]+(?:PORT|URL|HOST|ORIGIN))\s*=\s*(.+)/);
        if (!m) continue;
        const [, key, raw] = m;
        const val = raw.trim().replace(/^["']|["']$/g, "");
        if (/^https?:\/\//i.test(val)) {
          add(val, key!, envFile);
        } else if (/^\d{2,5}$/.test(val)) {
          add(`http://localhost:${val}`, `PORT=${val}`, envFile);
        }
      }
    } catch { /* skip */ }
  }

  // 2. Parse package.json scripts for --port / -p flags
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        const portM = script.match(/(?:--port|-p)\s+(\d{2,5})/);
        if (portM) add(`http://localhost:${portM[1]}`, `${name} script (--port ${portM[1]})`, "package.json");
      }
      // Framework-based defaults
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["vite"] && !seen.has("http://localhost:5173")) add("http://localhost:5173", "Vite default", "package.json");
      if (deps["next"] && !seen.has("http://localhost:3000")) add("http://localhost:3000", "Next.js default", "package.json");
      if ((deps["express"] || deps["fastify"] || deps["hono"]) && !seen.has("http://localhost:3001")) add("http://localhost:3001", "Node server default", "package.json");
    } catch { /* skip */ }
  }

  // 3. Parse vite.config for server.port
  for (const cfg of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
    const p = join(cwd, cfg);
    if (!existsSync(p)) continue;
    try {
      const src = readFileSync(p, "utf-8");
      const portM = src.match(/server\s*:\s*\{[^}]*port\s*:\s*(\d{2,5})/s);
      if (portM) add(`http://localhost:${portM[1]}`, `vite server.port`, cfg);
    } catch { /* skip */ }
  }

  // 4. PR / deployment URL from artifacts
  const artifacts = db.query(
    "SELECT content FROM artifacts WHERE task_id = ? AND kind = 'pr_url' ORDER BY created_at DESC LIMIT 5"
  ).all(taskId) as { content: string }[];
  for (const a of artifacts) {
    // Extract origin from PR URL (e.g. Vercel preview, Railway, etc.)
    try {
      const origin = new URL(a.content).origin;
      if (origin !== "null") add(origin, "PR deployment", "artifact");
    } catch { /* skip */ }
  }

  // 5. Fallback common ports
  if (suggestions.length === 0) {
    add("http://localhost:3000", "localhost:3000", "default");
    add("http://localhost:3001", "localhost:3001", "default");
    add("http://localhost:8000", "localhost:8000", "default");
  }

  return c.json({ suggestions });
});

// ─── Test-case run history (Phase 3d) ───────────────────────────────────────

/** Append a run-history row for a single test case. The UI calls this after
 *  every successful or failed runCase to feed the trend sparkline. */
tasksRouter.post("/tasks/:taskId/test-cases/:caseId/run", async (c) => {
  const { taskId, caseId } = c.req.param();
  const body = await c.req.json<{
    passed: boolean;
    durationMs: number;
    attempts?: number;
    output?: string;
    assertions?: unknown;
    ranAt?: string;
  }>().catch(() => null);
  if (!body) return c.json({ error: "Invalid body" }, 400);
  recordTestCaseRun({
    testCaseId: caseId,
    taskId,
    passed: !!body.passed,
    durationMs: Number(body.durationMs ?? 0),
    attempts: Math.max(1, Math.floor(Number(body.attempts ?? 1))),
    output: body.output ? String(body.output).slice(0, 8000) : null,
    assertionsJson: body.assertions ? JSON.stringify(body.assertions) : null,
    ranAt: body.ranAt ?? new Date().toISOString(),
  });
  return c.json({ ok: true });
});

/** Return per-day pass/fail trend over the last N days for one or all cases
 *  on this task. UI uses this to render sparklines per case. */
tasksRouter.get("/tasks/:taskId/test-runs", (c) => {
  const { taskId } = c.req.param();
  const caseId = c.req.query("caseId");
  const days = Number(c.req.query("days") ?? 14);
  if (caseId) {
    return c.json(getTestCaseTrend(caseId, days));
  }
  // No caseId → return trends for every distinct case_id on this task.
  // Useful for board-level dashboards (not used yet but cheap to provide).
  const db = getDb();
  const rows = db.query(
    "SELECT DISTINCT test_case_id FROM test_case_runs WHERE task_id = ?",
  ).all(taskId) as { test_case_id: string }[];
  return c.json({
    cases: rows.map((r) => ({ caseId: r.test_case_id, ...getTestCaseTrend(r.test_case_id, days) })),
  });
});

// Delete task
tasksRouter.delete("/tasks/:taskId", (c) => {
  const { taskId } = c.req.param();
  const db = getDb();
  db.query("DELETE FROM tasks WHERE id = ?").run(taskId);
  return c.json({ ok: true });
});

// SSE stream for live task activity — handled by executionsRouter.
// (Day-4 stub removed; the real handler at routes/executions.ts streams
//  actual telemetry from executionManager.subscribe.)
