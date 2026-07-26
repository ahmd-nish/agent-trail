import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../db.ts";
import { planFromPrd, type BoardDefaults, type LibraryCandidate } from "../../../core/src/planner/index.ts";
import type { Task } from "../../../core/src/types/index.ts";
import { listAgents } from "../../../core/src/library/store.ts";
import { resolveProjectRoot } from "../../../core/src/storage/paths.ts";

function defaultImplementationDir(boardName: string): string {
  const slug = boardName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "board";
  const path = join(homedir(), "agent-trail-runs", slug);
  try { mkdirSync(path, { recursive: true }); } catch { /* best effort */ }
  return path;
}

export const planRouter = new Hono();

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

  let boardId = body.boardId ?? "";
  let boardName = body.name ?? "";
  let boardDefaults: BoardDefaults = {};

  if (boardId) {
    const existing = db.query(
      "SELECT id, name, default_model, default_assignee, default_review_kind FROM boards WHERE id = ?",
    ).get(boardId) as {
      id: string; name: string;
      default_model: string | null;
      default_assignee: string | null;
      default_review_kind: string | null;
    } | null;
    if (!existing) return c.json({ error: `Board ${boardId} not found` }, 404);
    boardName = existing.name;
    boardDefaults = {
      defaultModel: existing.default_model,
      defaultAssignee: (existing.default_assignee ?? "claude-code") as BoardDefaults["defaultAssignee"],
      defaultReviewKind: (existing.default_review_kind ?? "none") as BoardDefaults["defaultReviewKind"],
    };
  } else if (!dryRun) {
    boardId = crypto.randomUUID();
    const implDir = defaultImplementationDir(boardName.trim());
    db.query(
      "INSERT INTO boards (id, name, permission_mode, implementation_dir, created_at, updated_at) VALUES (?, ?, 'acceptEdits', ?, ?, ?)",
    ).run(boardId, boardName.trim(), implDir, now, now);
  } else {
    boardId = crypto.randomUUID();
  }

  // §4.3 — feed the team library into the planner so it can auto-match
  // subagents per task. Best-effort: an unreadable library never blocks
  // the plan, we just fall back to zero candidates.
  let library: LibraryCandidate[] = [];
  try {
    library = listAgents(resolveProjectRoot()).map((e) => ({
      name: e.name, description: e.description,
    }));
  } catch { library = []; }

  let result: Awaited<ReturnType<typeof planFromPrd>>;
  try {
    result = await planFromPrd(body.prdText.trim(), boardId, boardDefaults, library);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  if (!dryRun) {
    const idMap = new Map<string, string>();
    for (const t of result.tasks) idMap.set(t.id, crypto.randomUUID());
    const mappedTasks = result.tasks.map((t) => ({
      ...t,
      id: idMap.get(t.id)!,
      dependsOn: t.dependsOn.map((dep) => idMap.get(dep) ?? dep),
    }));

    const insert = db.prepare(
      `INSERT INTO tasks
         (id, board_id, title, description, status, priority, assignee, tdd_enabled, tdd_phase,
          mcps, skills, subagents, depends_on, parallel_group,
          success_criteria, guardrails, epic, sprint, review_kind,
          model, model_tier, component, external_dependencies, test_cases,
          likely_paths, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const t of mappedTasks) {
      insert.run(
        t.id, boardId, t.title, t.description, t.status, t.priority, t.assignee,
        t.tddEnabled ? 1 : 0, t.tddPhase,
        JSON.stringify(t.mcps), JSON.stringify(t.skills), JSON.stringify(t.subagents),
        JSON.stringify(t.dependsOn), t.parallelGroup,
        JSON.stringify(t.successCriteria ?? []),
        JSON.stringify(t.guardrails ?? []),
        t.epic ?? null, t.sprint ?? null, t.reviewKind ?? "none",
        t.model ?? null, t.modelTier ?? null, t.component ?? null,
        JSON.stringify(t.externalDependencies ?? []),
        JSON.stringify(t.testCases ?? []),
        JSON.stringify(t.likelyPaths ?? []),
        t.createdAt, t.updatedAt,
      );
    }

    result = { ...result, tasks: mappedTasks };
  }

  return c.json({
    board: dryRun ? null : { id: boardId, name: boardName },
    tasks: result.tasks as Task[],
    usage: result.usage,
    dryRun,
  });
});
