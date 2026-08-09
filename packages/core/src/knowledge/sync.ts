// knowledgelayer §4.6 / knowledgelayer-v2 §7 — sync: a cursor, not a sync engine.
//
// The log is append-only and ULID-keyed, and ULIDs sort by creation time. Two
// machines that have seen the same set of ids are in the same state regardless
// of the order they saw them in — a grow-only set, which is a CRDT for free
// (§4.1 property 2).
//
// That is why there is **no outbox table here**. An outbox exists to remember
// which mutations are unsent; for an append-only log the answer is "everything
// after the last id I pushed", which is one string. Adding an outbox would be
// adding bookkeeping for a problem the data model already deleted.
//
// Explicitly NOT adopting ElectricSQL / PowerSync / Zero / LiveStore or any
// CRDT library. Those solve bidirectional sync of MUTABLE rows. We deliberately
// do not have mutable rows, and adopting one would be a multi-quarter platform
// commitment to solve a problem we designed away.
//
// What syncs is the small, precious half. The derived code graph is never sent:
// it rebuilds locally in milliseconds and would be hundreds of MB on the wire.
// Asserted knowledge is ~1KB/event — 10k events is about 10MB.

import type { Database } from "bun:sqlite";
import { appendEdge, hasEdgeTable, type KnowledgeEdge, type NewKnowledgeEdge } from "./edges.ts";
import { append, rowToEvent, type RawRow } from "./store.ts";
import type { KnowledgeEvent, NewKnowledgeEvent } from "./types.ts";

export const SYNC_STATE_DDL = `
CREATE TABLE IF NOT EXISTS sync_state (
  remote            TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  push_cursor_event TEXT,
  push_cursor_edge  TEXT,
  pull_cursor       TEXT,
  last_push_at      TEXT,
  last_pull_at      TEXT,
  last_error        TEXT
);
`;

export interface SyncState {
  remote: string;
  workspaceId: string;
  projectId: string;
  pushCursorEvent: string | null;
  pushCursorEdge: string | null;
  pullCursor: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
}

export interface SyncEnvelope {
  events: KnowledgeEvent[];
  edges: KnowledgeEdge[];
  /** Highest id in this envelope — the caller's next `since`. */
  cursor: string | null;
}

export interface SyncResult {
  pushed: { events: number; edges: number };
  pulled: { events: number; edges: number };
  cursor: string | null;
  skipped: boolean;
  reason?: string;
  /** True when a batch limit was hit, so more remains. One syncOnce() drains at
   *  most `batchLimit`; a caller with a backlog must loop until this is false.
   *  Reported rather than looped internally so an unbounded backlog cannot turn
   *  a single call into an unbounded run. */
  hasMore: boolean;
}

function hasTable(db: Database, name: string): boolean {
  try {
    return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch { return false; }
}

export function ensureSyncState(db: Database): void {
  db.exec(SYNC_STATE_DDL);
}

export function getSyncState(db: Database, remote: string): SyncState | null {
  if (!hasTable(db, "sync_state")) return null;
  const row = db.query("SELECT * FROM sync_state WHERE remote = ?").get(remote) as Record<string, string | null> | null;
  if (!row) return null;
  return {
    remote: row.remote as string,
    workspaceId: row.workspace_id as string,
    projectId: row.project_id as string,
    pushCursorEvent: row.push_cursor_event,
    pushCursorEdge: row.push_cursor_edge,
    pullCursor: row.pull_cursor,
    lastPushAt: row.last_push_at,
    lastPullAt: row.last_pull_at,
    lastError: row.last_error,
  };
}

export function upsertSyncState(db: Database, s: Partial<SyncState> & Pick<SyncState, "remote" | "workspaceId" | "projectId">): void {
  ensureSyncState(db);
  db.query(
    `INSERT INTO sync_state (remote, workspace_id, project_id, push_cursor_event, push_cursor_edge, pull_cursor, last_push_at, last_pull_at, last_error)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(remote) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       project_id = excluded.project_id,
       push_cursor_event = COALESCE(excluded.push_cursor_event, sync_state.push_cursor_event),
       push_cursor_edge = COALESCE(excluded.push_cursor_edge, sync_state.push_cursor_edge),
       pull_cursor = COALESCE(excluded.pull_cursor, sync_state.pull_cursor),
       last_push_at = COALESCE(excluded.last_push_at, sync_state.last_push_at),
       last_pull_at = COALESCE(excluded.last_pull_at, sync_state.last_pull_at),
       last_error = excluded.last_error`,
  ).run(
    s.remote, s.workspaceId, s.projectId,
    s.pushCursorEvent ?? null, s.pushCursorEdge ?? null, s.pullCursor ?? null,
    s.lastPushAt ?? null, s.lastPullAt ?? null, s.lastError ?? null,
  );
}

// ── Read the local side ──────────────────────────────────────────────────────

/** Everything created after the push cursors. ULIDs sort lexically by time, so
 *  "after" is a plain string comparison — no timestamps, no clock skew. */
export function pendingPush(
  db: Database,
  opts: { workspaceId: string; projectId: string; sinceEvent?: string | null; sinceEdge?: string | null; limit?: number },
): { events: KnowledgeEvent[]; edges: KnowledgeEdge[] } {
  const limit = opts.limit ?? 500;
  // Paged in SQL, not filtered in memory. list() would materialize the WHOLE
  // log on every sync — fine at 5k events, ruinous at 100k, and a sync path is
  // exactly where that grows without anyone noticing.
  //
  // activeOnly is deliberately absent: supersession is itself state that has to
  // replicate, so superseded rows must go over the wire too.
  const events = (db.query(
    `SELECT * FROM knowledge_events
      WHERE workspace_id = ? AND project_id = ? AND (? = '' OR id > ?)
      ORDER BY id LIMIT ?`,
  ).all(
    opts.workspaceId, opts.projectId,
    opts.sinceEvent ?? "", opts.sinceEvent ?? "",
    limit,
  ) as RawRow[]).map(rowToEvent);

  let edges: KnowledgeEdge[] = [];
  if (hasEdgeTable(db)) {
    edges = (db.query(
      `SELECT * FROM knowledge_edges
        WHERE workspace_id = ? AND project_id = ? AND (? = '' OR id > ?)
        ORDER BY id LIMIT ?`,
    ).all(opts.workspaceId, opts.projectId, opts.sinceEdge ?? "", opts.sinceEdge ?? "", limit) as Array<Record<string, unknown>>)
      .map(rowToEdge);
  }
  return { events, edges };
}

function rowToEdge(r: Record<string, unknown>): KnowledgeEdge {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    projectId: r.project_id as string,
    src: r.src as string,
    dst: r.dst as string,
    kind: r.kind as KnowledgeEdge["kind"],
    weight: Number(r.weight ?? 1),
    resolver: r.resolver as string,
    contentHash: r.content_hash as string,
    createdAt: r.created_at as string,
  };
}

// ── Apply the remote side ────────────────────────────────────────────────────

/**
 * Idempotent apply. Original ULIDs are preserved so the same event has the same
 * identity on every machine — that is what makes `governs` edges (which point
 * at `kev:<ulid>`) resolvable after they cross a wire.
 *
 * Malformed rows are skipped rather than aborting the batch: one bad row from a
 * newer client must not stall a teammate's entire sync.
 */
export function applyIncoming(
  db: Database,
  envelope: { events?: unknown[]; edges?: unknown[] },
): { events: number; edges: number; rejected: number } {
  let events = 0, edges = 0, rejected = 0;

  for (const raw of envelope.events ?? []) {
    try {
      const e = raw as KnowledgeEvent;
      if (!e?.id || !e.type || !e.subject) { rejected++; continue; }
      const input: NewKnowledgeEvent = {
        id: e.id,
        workspaceId: e.workspaceId, projectId: e.projectId,
        actorKind: e.actorKind, actorId: e.actorId, actorName: e.actorName,
        taskId: e.taskId ?? null, executionId: e.executionId ?? null,
        type: e.type, scope: e.scope, subject: e.subject, body: e.body ?? "",
        paths: Array.isArray(e.paths) ? e.paths : [],
        confidence: e.confidence, validFrom: e.validFrom,
        supersedes: e.supersedes ?? null,
      };
      if (append(db, input).inserted) events++;
    } catch { rejected++; }
  }

  for (const raw of envelope.edges ?? []) {
    try {
      const g = raw as KnowledgeEdge;
      if (!g?.src || !g.dst || !g.kind) { rejected++; continue; }
      const input: NewKnowledgeEdge = {
        id: g.id,
        workspaceId: g.workspaceId, projectId: g.projectId,
        src: g.src, dst: g.dst, kind: g.kind,
        weight: g.weight ?? 1, resolver: g.resolver ?? "remote",
      };
      if (appendEdge(db, input)) edges++;
    } catch { rejected++; }
  }

  return { events, edges, rejected };
}

/** Highest id across an envelope — the next cursor. */
export function envelopeCursor(events: Array<{ id: string }>, edges: Array<{ id: string }>): string | null {
  const ids = [...events.map((e) => e.id), ...edges.map((e) => e.id)].filter(Boolean).sort();
  return ids.length ? ids[ids.length - 1]! : null;
}

// ── The client ───────────────────────────────────────────────────────────────

export interface SyncOptions {
  remote: string;
  /** REMOTE identity — the workspace this relay account belongs to. Note the
   *  relay re-derives this from the token regardless; it is sent for clarity
   *  and used to tag pull requests. */
  workspaceId: string;
  projectId: string;
  /**
   * LOCAL identity — what to read out of this machine's log.
   *
   * These exist because events are emitted with `workspace_id = 'local'`: a
   * board has no idea which relay workspace it will eventually belong to. If
   * push read using the REMOTE workspace id, it would match zero rows and
   * report a cheerful "pushed 0" forever — which is exactly what happened the
   * first time this stack ran end-to-end.
   *
   * Default is the remote id (least surprising for a caller whose rows already
   * carry it); the CLI passes "local" explicitly.
   */
  localWorkspaceId?: string;
  localProjectId?: string;
  token?: string;
  /** §5.2 trust — when true, nothing leaves this machine. Checked FIRST, before
   *  any read of the log, so a local-only project cannot leak through a bug
   *  further down this function. */
  localOnly?: boolean;
  fetchImpl?: typeof fetch;
  batchLimit?: number;
}

/**
 * One push-then-pull round trip. Offline is not an error state: the cursors do
 * not advance, so the next successful call sends exactly what this one could
 * not. Append-only means there is never a conflict to resolve.
 */
export async function syncOnce(db: Database, opts: SyncOptions): Promise<SyncResult> {
  const empty: SyncResult = { pushed: { events: 0, edges: 0 }, pulled: { events: 0, edges: 0 }, cursor: null, skipped: true, hasMore: false };
  if (opts.localOnly) return { ...empty, reason: "sync:local-only — nothing left this machine" };

  ensureSyncState(db);
  const doFetch = opts.fetchImpl ?? fetch;
  const state = getSyncState(db, opts.remote);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  const result: SyncResult = { pushed: { events: 0, edges: 0 }, pulled: { events: 0, edges: 0 }, cursor: state?.pullCursor ?? null, skipped: false, hasMore: false };

  // ── Push ────────────────────────────────────────────────────────────────
  const batchLimit = opts.batchLimit ?? 500;
  // Defaults to the remote workspace — least surprising for a library caller
  // whose rows already carry it. The CLI passes "local" explicitly, because it
  // knows locally-emitted events are always stamped that way.
  const localWorkspaceId = opts.localWorkspaceId ?? opts.workspaceId;
  const localProjectId = opts.localProjectId ?? opts.projectId;
  const { events, edges } = pendingPush(db, {
    workspaceId: localWorkspaceId,
    projectId: localProjectId,
    sinceEvent: state?.pushCursorEvent ?? null,
    sinceEdge: state?.pushCursorEdge ?? null,
    limit: batchLimit,
  });
  if (events.length === batchLimit || edges.length === batchLimit) result.hasMore = true;

  try {
    if (events.length || edges.length) {
      const res = await doFetch(`${opts.remote.replace(/\/$/, "")}/v1/events`, {
        method: "POST", headers,
        body: JSON.stringify({ workspaceId: opts.workspaceId, projectId: opts.projectId, events, edges }),
      });
      if (!res.ok) throw new Error(`push failed: ${res.status} ${await res.text().catch(() => "")}`);
      result.pushed = { events: events.length, edges: edges.length };
      upsertSyncState(db, {
        remote: opts.remote, workspaceId: opts.workspaceId, projectId: opts.projectId,
        pushCursorEvent: events.length ? events[events.length - 1]!.id : undefined,
        pushCursorEdge: edges.length ? edges[edges.length - 1]!.id : undefined,
        lastPushAt: new Date().toISOString(),
        lastError: null,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    upsertSyncState(db, { remote: opts.remote, workspaceId: opts.workspaceId, projectId: opts.projectId, lastError: msg });
    return { ...result, skipped: true, reason: msg };
  }

  // ── Pull ────────────────────────────────────────────────────────────────
  try {
    const since = getSyncState(db, opts.remote)?.pullCursor ?? "";
    const url = `${opts.remote.replace(/\/$/, "")}/v1/events?since=${encodeURIComponent(since)}&workspace=${encodeURIComponent(opts.workspaceId)}&project=${encodeURIComponent(opts.projectId)}`;
    const res = await doFetch(url, { headers });
    if (!res.ok) throw new Error(`pull failed: ${res.status}`);
    const envelope = await res.json() as SyncEnvelope & { hasMore?: boolean };
    if (envelope.hasMore) result.hasMore = true;
    const applied = applyIncoming(db, envelope);
    result.pulled = { events: applied.events, edges: applied.edges };
    const cursor = envelope.cursor ?? envelopeCursor(envelope.events ?? [], envelope.edges ?? []);
    if (cursor) {
      upsertSyncState(db, {
        remote: opts.remote, workspaceId: opts.workspaceId, projectId: opts.projectId,
        pullCursor: cursor, lastPullAt: new Date().toISOString(), lastError: null,
      });
      result.cursor = cursor;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    upsertSyncState(db, { remote: opts.remote, workspaceId: opts.workspaceId, projectId: opts.projectId, lastError: msg });
    return { ...result, skipped: true, reason: msg };
  }

  return result;
}


/**
 * Distinct (workspace, project) pairs present in the local log.
 *
 * Exists so a caller can turn a bewildering "pushed 0" into an actionable
 * message. A silent no-op that looks like success is worse than an error.
 */
export function localIdentities(db: Database): Array<{ workspaceId: string; projectId: string; events: number }> {
  try {
    return (db.query(
      `SELECT workspace_id, project_id, COUNT(*) AS n FROM knowledge_events
        GROUP BY workspace_id, project_id ORDER BY n DESC`,
    ).all() as Array<{ workspace_id: string; project_id: string; n: number }>)
      .map((r) => ({ workspaceId: r.workspace_id, projectId: r.project_id, events: r.n }));
  } catch {
    return [];
  }
}
