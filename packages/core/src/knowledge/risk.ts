import type { Database } from "bun:sqlite";
import type { KnowledgeEvent } from "./types.ts";

// §4.5 governance gate — the multiplayer feature nobody has.
//
// projectmem shipped a single-user `precheck` that consults the local
// event log before an agent's next action. Ours is the team's: if Sarah
// tried a null-guard in `auth/session.ts` two days ago and it failed with
// the same assertion, this agent's plan (on this branch, on this machine)
// should see that warning before doing the same thing.
//
// Deterministic. No model call. No embeddings. Just an index over the
// existing failed_attempt / gotcha / thrash events, scoped by file path.

export interface RiskWarning {
  path: string;
  count: number;
  events: KnowledgeEvent[];
}

export interface RiskIndex {
  perPath: Record<string, RiskWarning>;
  totalHits: number;
}

export interface RiskIndexOptions {
  workspaceId?: string;
  projectId?: string;
  /** Cap warnings per path — noisiest files can otherwise dominate the pack. */
  maxEventsPerPath?: number;
  /** Only include events strictly more recent than this ISO date. Default: last 90 days. */
  since?: string;
}

const RISK_EVENT_TYPES = ["failed_attempt", "gotcha"] as const;

/**
 * Build a risk index over the given paths. Used by `precheck()` at pack time
 * and can be regenerated cheaply on demand — no persisted state.
 */
export function buildRiskIndex(db: Database, paths: string[], opts: RiskIndexOptions = {}): RiskIndex {
  const distinctPaths = [...new Set(paths.filter(Boolean))];
  const perPath: Record<string, RiskWarning> = {};
  let totalHits = 0;
  if (distinctPaths.length === 0) return { perPath, totalHits };

  const maxEvents = Math.max(1, opts.maxEventsPerPath ?? 5);
  const cutoff = opts.since ?? isoDaysAgo(90);

  const clauses: string[] = [
    `type IN (${RISK_EVENT_TYPES.map(() => "?").join(",")})`,
    "superseded_by IS NULL",
    "valid_from >= ?",
  ];
  const params: unknown[] = [...RISK_EVENT_TYPES, cutoff];
  if (opts.workspaceId) { clauses.push("workspace_id = ?"); params.push(opts.workspaceId); }
  if (opts.projectId)   { clauses.push("project_id = ?");   params.push(opts.projectId); }

  const rows = db.query(
    `SELECT * FROM knowledge_events WHERE ${clauses.join(" AND ")} ORDER BY id DESC`,
  ).all(...params) as Array<{
    id: string; workspace_id: string; project_id: string;
    actor_kind: string; actor_id: string; actor_name: string;
    task_id: string | null; execution_id: string | null;
    type: string; scope: string; subject: string; body: string;
    paths: string; confidence: string; valid_from: string;
    supersedes: string | null; superseded_by: string | null;
    content_hash: string; created_at: string;
  }>;

  for (const row of rows) {
    const eventPaths = safeParsePaths(row.paths);
    for (const p of distinctPaths) {
      if (!pathMatches(p, eventPaths, row.scope)) continue;
      const bucket = perPath[p] ?? (perPath[p] = { path: p, count: 0, events: [] });
      bucket.count++;
      totalHits++;
      if (bucket.events.length < maxEvents) bucket.events.push(rowToEvent(row));
    }
  }

  return { perPath, totalHits };
}

/**
 * Format the risk index as a compact Band-D warning block. What the agent
 * actually reads. Empty perPath returns "" so callers can safely concat.
 */
export function formatRiskWarnings(index: RiskIndex): string {
  const entries = Object.values(index.perPath);
  if (entries.length === 0) return "";
  entries.sort((a, b) => b.count - a.count);

  const lines: string[] = [];
  lines.push("=== risk index — this task's files have prior failed attempts ===");
  lines.push("");
  for (const w of entries) {
    lines.push(`- ${w.path} (${w.count} prior ${w.count === 1 ? "hit" : "hits"})`);
    for (const ev of w.events) {
      const date = ev.validFrom.slice(0, 10);
      lines.push(`  · ${date} · ${ev.actorName} · ${ev.type} · ${ev.subject}`);
    }
  }
  lines.push("");
  lines.push("Consider a different approach on these files before repeating what already failed.");
  return lines.join("\n");
}

function pathMatches(target: string, eventPaths: string[], scope: string): boolean {
  // Direct path membership in the event's paths array.
  if (eventPaths.some((p) => p === target || target.startsWith(`${p}/`) || p.startsWith(`${target}/`))) return true;
  // Or the scope points at this path (module:packages/core → matches packages/core/**).
  if (scope.startsWith("module:")) {
    const module = scope.slice("module:".length);
    if (target === module || target.startsWith(`${module}/`) || module.startsWith(`${target}/`)) return true;
  }
  return false;
}

function safeParsePaths(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function rowToEvent(row: {
  id: string; workspace_id: string; project_id: string;
  actor_kind: string; actor_id: string; actor_name: string;
  task_id: string | null; execution_id: string | null;
  type: string; scope: string; subject: string; body: string;
  paths: string; confidence: string; valid_from: string;
  supersedes: string | null; superseded_by: string | null;
  content_hash: string; created_at: string;
}): KnowledgeEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id, projectId: row.project_id,
    actorKind: row.actor_kind as "human" | "agent",
    actorId: row.actor_id, actorName: row.actor_name,
    taskId: row.task_id, executionId: row.execution_id,
    type: row.type as KnowledgeEvent["type"],
    scope: row.scope as KnowledgeEvent["scope"],
    subject: row.subject, body: row.body,
    paths: safeParsePaths(row.paths),
    confidence: row.confidence as KnowledgeEvent["confidence"],
    validFrom: row.valid_from,
    supersedes: row.supersedes, supersededBy: row.superseded_by,
    contentHash: row.content_hash, createdAt: row.created_at,
  };
}
