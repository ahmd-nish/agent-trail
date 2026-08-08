import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { emitContractEdges, emitPathEdges } from "./edges.ts";
import { redact } from "./redact.ts";
import type { EventType, KnowledgeEvent, NewKnowledgeEvent, Scope } from "./types.ts";
import { bodyCapFor } from "./types.ts";
import { ulid } from "./ulid.ts";

// The write path. Every knowledge-producing site in the codebase (decision
// tickets, iteration memories, thrash, steering, artifacts) calls append().
// It:
//   1. redacts secrets (§5.2) before anything touches disk
//   2. clamps body to the cap for its type — prose 1200, contract 4000
//      (knowledgelayer-v2 §2; see bodyCapFor in types.ts for the reasoning)
//   3. hashes the semantic payload so backfill/replay is idempotent
//   4. stamps id + createdAt + validFrom
//   5. writes atomically
//
// Idempotence is via UNIQUE (workspace_id, project_id, content_hash) — a
// re-run of the emitter (e.g. crash-resume replays a prior tool call)
// silently keeps the original row. That's what makes the log a grow-only
// set (§4.1 property 2).

export interface AppendOptions {
  /** If true, throw on duplicate content_hash instead of silently keeping the original. */
  strict?: boolean;
}

export interface AppendResult {
  event: KnowledgeEvent;
  /** True if this call inserted a new row; false if an identical row already existed. */
  inserted: boolean;
}

export function append(db: Database, input: NewKnowledgeEvent, opts: AppendOptions = {}): AppendResult {
  const now = new Date().toISOString();
  const redactedSubject = redact(input.subject).clean;
  // Redact first, then clamp — a cap applied before redaction could slice a
  // secret in half and leave the tail in the row.
  const cleanBody = redact(input.body).clean;
  const redactedBody = cleanBody.slice(0, bodyCapFor(input.type, cleanBody));

  const contentHash = hashEvent({
    type: input.type,
    scope: input.scope,
    subject: redactedSubject,
    body: redactedBody,
    supersedes: input.supersedes,
  });

  // Idempotence check — the UNIQUE index would enforce this too, but
  // catching it here lets us return the *existing* row without a rollback.
  const existing = db.query(
    "SELECT id FROM knowledge_events WHERE workspace_id = ? AND project_id = ? AND content_hash = ? LIMIT 1",
  ).get(input.workspaceId, input.projectId, contentHash) as { id: string } | null;

  if (existing) {
    if (opts.strict) throw new Error(`knowledge_events content_hash collision: ${contentHash}`);
    const row = getById(db, existing.id);
    if (!row) throw new Error(`knowledge_events row vanished mid-read: ${existing.id}`);
    return { event: row, inserted: false };
  }

  const event: KnowledgeEvent = {
    id: input.id ?? ulid(),
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorKind: input.actorKind,
    actorId: input.actorId,
    actorName: input.actorName,
    taskId: input.taskId,
    executionId: input.executionId,
    type: input.type,
    scope: input.scope,
    subject: redactedSubject,
    body: redactedBody,
    paths: input.paths ?? [],
    confidence: input.confidence,
    validFrom: input.validFrom ?? now,
    supersedes: input.supersedes ?? null,
    supersededBy: null,
    contentHash,
    createdAt: now,
  };

  db.transaction(() => {
    db.query(
      `INSERT INTO knowledge_events
        (id, workspace_id, project_id, actor_kind, actor_id, actor_name,
         task_id, execution_id, type, scope, subject, body, paths,
         confidence, valid_from, supersedes, superseded_by, content_hash, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      event.id, event.workspaceId, event.projectId, event.actorKind, event.actorId, event.actorName,
      event.taskId, event.executionId, event.type, event.scope, event.subject, event.body,
      JSON.stringify(event.paths), event.confidence, event.validFrom, event.supersedes,
      event.supersededBy, event.contentHash, event.createdAt,
    );

    // §J auto-population — nobody types anything, and the graph is current
    // within one task of the work that changed it. Both calls are best-effort
    // and swallow their own errors: an edge failure must never lose the event
    // that caused it. Symbol edges are NOT resolved here — that needs an async
    // adapter call and must not sit on the synchronous write path.
    emitPathEdges(db, event);
    emitContractEdges(db, event);

    // Close out the superseded ancestor if any. Temporal validity (§3.2 fix):
    // the old event still exists — we're just marking its validity window closed.
    if (event.supersedes) {
      db.query(
        "UPDATE knowledge_events SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL",
      ).run(event.id, event.supersedes);
    }
  })();

  return { event, inserted: true };
}

export interface ListFilter {
  workspaceId?: string;
  projectId?: string;
  type?: EventType;
  scope?: Scope;
  /** Only include events currently active (not superseded). Default true. */
  activeOnly?: boolean;
  /** Cursor for tail sync — return events strictly after this ULID. */
  sinceId?: string;
  limit?: number;
}

export function list(db: Database, filter: ListFilter = {}): KnowledgeEvent[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.workspaceId) { clauses.push("workspace_id = ?"); params.push(filter.workspaceId); }
  if (filter.projectId)   { clauses.push("project_id = ?");   params.push(filter.projectId); }
  if (filter.type)        { clauses.push("type = ?");         params.push(filter.type); }
  if (filter.scope)       { clauses.push("scope = ?");        params.push(filter.scope); }
  if (filter.activeOnly !== false) clauses.push("superseded_by IS NULL");
  if (filter.sinceId)     { clauses.push("id > ?"); params.push(filter.sinceId); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : "";
  const rows = db.query(
    `SELECT * FROM knowledge_events ${where} ORDER BY id ASC ${limit}`,
  ).all(...params) as RawRow[];

  return rows.map(rowToEvent);
}

export function getById(db: Database, id: string): KnowledgeEvent | null {
  const row = db.query("SELECT * FROM knowledge_events WHERE id = ?").get(id) as RawRow | null;
  return row ? rowToEvent(row) : null;
}

/**
 * Count events matching a filter — used by projections that need a cheap
 * "did the log grow since I last folded?" check without materializing rows.
 */
export function count(db: Database, filter: ListFilter = {}): number {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.workspaceId) { clauses.push("workspace_id = ?"); params.push(filter.workspaceId); }
  if (filter.projectId)   { clauses.push("project_id = ?");   params.push(filter.projectId); }
  if (filter.type)        { clauses.push("type = ?");         params.push(filter.type); }
  if (filter.scope)       { clauses.push("scope = ?");        params.push(filter.scope); }
  if (filter.activeOnly !== false) clauses.push("superseded_by IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db.query(`SELECT COUNT(*) AS n FROM knowledge_events ${where}`).get(...params) as { n: number };
  return row.n;
}

export interface RawRow {
  id: string; workspace_id: string; project_id: string;
  actor_kind: string; actor_id: string; actor_name: string;
  task_id: string | null; execution_id: string | null;
  type: string; scope: string; subject: string; body: string;
  paths: string;
  confidence: string; valid_from: string;
  supersedes: string | null; superseded_by: string | null;
  content_hash: string; created_at: string;
}

/** Exported for §J — edges.ts joins rows out of knowledge_events directly and
 *  must map them identically, not with a second hand-rolled mapper. */
export function rowToEvent(row: RawRow): KnowledgeEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    actorKind: row.actor_kind as "human" | "agent",
    actorId: row.actor_id,
    actorName: row.actor_name,
    taskId: row.task_id,
    executionId: row.execution_id,
    type: row.type as EventType,
    scope: row.scope as Scope,
    subject: row.subject,
    body: row.body,
    paths: safeJsonArray(row.paths),
    confidence: row.confidence as KnowledgeEvent["confidence"],
    validFrom: row.valid_from,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

interface HashInput {
  type: string; scope: string; subject: string; body: string;
  supersedes: string | null | undefined;
}
export function hashEvent(input: HashInput): string {
  // Hash the semantic payload only — id / actor / timestamps are metadata and
  // must not affect dedupe. Two humans making the same ruling on the same
  // task on different days ARE the same fact and should collapse.
  const canonical = JSON.stringify({
    type: input.type,
    scope: input.scope,
    subject: input.subject.trim(),
    body: input.body.trim(),
    supersedes: input.supersedes ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
