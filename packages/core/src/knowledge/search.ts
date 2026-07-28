import type { Database } from "bun:sqlite";
import type { EventType, KnowledgeEvent, Scope } from "./types.ts";

// FTS5-backed ranked search over the event log (doc §4.3 "seed" step).
//
// Full hybrid retrieval — BM25 + vector kNN + RRF fusion + graph traversal
// + confidence weighting — needs an embedding pipeline (nomic-embed-text
// 256d Matryoshka) which is deliberately deferred. Meanwhile FTS5's
// built-in bm25() ranker + porter stemmer + unicode61 tokenizer is a
// dramatic step up from LIKE and requires zero extra dependencies.
//
// Scoring:
//   raw          bm25(fts) — lower is better in FTS5's convention
//   confBoost    ruling × 1.0 · observed × 0.8 · inferred × 0.5
//   activityBias 0 for superseded (excluded); 1 for active
//   final = -raw × confBoost × activityBias   (higher = better)
//
// Full §4.3 scoring (edge_kind_weight × distance_decay × recency_decay ×
// path_overlap_boost × superseded=0) needs the code graph; when that
// lands the score function here is replaced with the fused formula.

export interface SearchOptions {
  workspaceId?: string;
  projectId?: string;
  type?: EventType;
  scope?: Scope;
  limit?: number;
}

export interface SearchHit {
  event: KnowledgeEvent;
  score: number;
  bm25: number;
}

export function search(db: Database, query: string, opts: SearchOptions = {}): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const clauses: string[] = [
    "knowledge_events_fts MATCH ?",
    "ke.superseded_by IS NULL",
  ];
  const params: unknown[] = [ftsQuery(trimmed)];
  if (opts.workspaceId) { clauses.push("ke.workspace_id = ?"); params.push(opts.workspaceId); }
  if (opts.projectId)   { clauses.push("ke.project_id = ?");   params.push(opts.projectId); }
  if (opts.type)        { clauses.push("ke.type = ?");         params.push(opts.type); }
  if (opts.scope)       { clauses.push("ke.scope = ?");        params.push(opts.scope); }
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 20)));

  const rows = db.query(
    `SELECT
        ke.*,
        bm25(knowledge_events_fts) AS bm25
     FROM knowledge_events_fts
     JOIN knowledge_events ke ON ke.rowid = knowledge_events_fts.rowid
     WHERE ${clauses.join(" AND ")}
     ORDER BY bm25 ASC
     LIMIT ${limit}`,
  ).all(...params) as Array<{
    id: string; workspace_id: string; project_id: string;
    actor_kind: string; actor_id: string; actor_name: string;
    task_id: string | null; execution_id: string | null;
    type: string; scope: string; subject: string; body: string;
    paths: string; confidence: string; valid_from: string;
    supersedes: string | null; superseded_by: string | null;
    content_hash: string; created_at: string; bm25: number;
  }>;

  return rows.map((r) => {
    const event: KnowledgeEvent = {
      id: r.id,
      workspaceId: r.workspace_id, projectId: r.project_id,
      actorKind: r.actor_kind as "human" | "agent",
      actorId: r.actor_id, actorName: r.actor_name,
      taskId: r.task_id, executionId: r.execution_id,
      type: r.type as EventType, scope: r.scope as Scope,
      subject: r.subject, body: r.body,
      paths: safeParsePaths(r.paths),
      confidence: r.confidence as KnowledgeEvent["confidence"],
      validFrom: r.valid_from,
      supersedes: r.supersedes, supersededBy: r.superseded_by,
      contentHash: r.content_hash, createdAt: r.created_at,
    };
    const confBoost = event.confidence === "ruling" ? 1.0 : event.confidence === "observed" ? 0.8 : 0.5;
    const score = -r.bm25 * confBoost;
    return { event, score, bm25: r.bm25 };
  });
}

// FTS5 accepts a mini-query language (AND/OR/NOT, "phrase", column:token,
// prefix "term*"). Ordinary user input like `"how do we handle auth?"`
// contains an unquoted `?` that FTS5 would reject.
//
// We sanitize by quoting each whitespace-separated token and OR-joining
// them. OR is intentional: BM25 handles precision via ranking, and
// implicit-AND ("how" AND "do" AND "we") would miss the actually-relevant
// document that only contains "auth" and "handle". This is the seed step
// of §4.3's "seed → expand → score → cut" — coverage first, precision
// via score, then a hard cut.
function ftsQuery(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => tok.replace(/[^\p{L}\p{N}_]+/gu, "")) // strip punctuation the tokenizer would reject
    .filter(Boolean)
    .map((tok) => `"${tok}"`);
  return tokens.length ? tokens.join(" OR ") : "\"\"";
}

function safeParsePaths(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
