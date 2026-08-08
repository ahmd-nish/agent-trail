// knowledgelayer §4.6 — the relay. Three endpoints, and that is the entire
// sync protocol.
//
//   POST /v1/events                     append, dedupe on content_hash
//   GET  /v1/events?since=<ulid>        tail, returns the next cursor
//   GET  /v1/events/stream?since=<ulid> SSE live tail
//
// Mounted on the existing Hono server so self-hosting is the default rather
// than a special build: the same binary is a local board and a relay.
//
// ── Auth, stated honestly ───────────────────────────────────────────────────
// A shared bearer token (AGENT_TRAIL_RELAY_TOKEN). That is enough for a
// self-hosted team relay and nothing more. The §5.1 hosted tier needs
// per-user identity (better-auth + GitHub OAuth) and a real workspace model
// with membership — neither is here, and a shared secret must not be mistaken
// for either. Relay is DISABLED unless the token is set, so an unguarded
// instance cannot be stood up by accident.

import { Hono } from "hono";
import { getDb } from "../db.js";
import {
  applyIncoming, envelopeCursor,
} from "../../../core/src/knowledge/sync.ts";
import { hasEdgeTable } from "../../../core/src/knowledge/edges.ts";
import { rowToEvent, type RawRow } from "../../../core/src/knowledge/store.ts";

export const relayRouter = new Hono();

const PAGE_LIMIT = 500;

function relayToken(): string | null {
  const t = process.env["AGENT_TRAIL_RELAY_TOKEN"];
  return t && t.trim() ? t.trim() : null;
}

/** Constant-time-ish compare so a token cannot be recovered byte-by-byte from
 *  response timing. Lengths differing is already a mismatch. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorize(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const expected = relayToken();
  if (!expected) return "relay disabled — set AGENT_TRAIL_RELAY_TOKEN to enable";
  const header = c.req.header("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!provided || !tokensMatch(provided, expected)) return "unauthorized";
  return null;
}

relayRouter.post("/v1/events", async (c) => {
  const denied = authorize(c);
  if (denied) return c.json({ error: denied }, denied === "unauthorized" ? 401 : 503);

  const body = await c.req.json<{ workspaceId?: string; projectId?: string; events?: unknown[]; edges?: unknown[] }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);

  const events = Array.isArray(body.events) ? body.events : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];
  if (events.length > PAGE_LIMIT * 4 || edges.length > PAGE_LIMIT * 4) {
    return c.json({ error: "batch too large" }, 413);
  }

  // applyIncoming is idempotent on content_hash, so a client retrying after a
  // dropped response re-sends safely — the append-only log's whole point.
  const applied = applyIncoming(getDb(), { events, edges });
  return c.json({
    inserted: { events: applied.events, edges: applied.edges },
    rejected: applied.rejected,
    cursor: envelopeCursor(events as Array<{ id: string }>, edges as Array<{ id: string }>),
  });
});

relayRouter.get("/v1/events", (c) => {
  const denied = authorize(c);
  if (denied) return c.json({ error: denied }, denied === "unauthorized" ? 401 : 503);

  const since = c.req.query("since") ?? "";
  const workspace = c.req.query("workspace") ?? "local";
  const project = c.req.query("project") ?? "local";
  const db = getDb();

  const events = (db.query(
    `SELECT * FROM knowledge_events
      WHERE workspace_id = ? AND project_id = ? AND (? = '' OR id > ?)
      ORDER BY id LIMIT ?`,
  ).all(workspace, project, since, since, PAGE_LIMIT) as RawRow[]).map(rowToEvent);

  const edges = hasEdgeTable(db)
    ? db.query(
        `SELECT * FROM knowledge_edges
          WHERE workspace_id = ? AND project_id = ? AND (? = '' OR id > ?)
          ORDER BY id LIMIT ?`,
      ).all(workspace, project, since, since, PAGE_LIMIT) as Array<Record<string, unknown>>
    : [];

  const mappedEdges = edges.map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    projectId: r.project_id as string,
    src: r.src as string,
    dst: r.dst as string,
    kind: r.kind as string,
    weight: Number(r.weight ?? 1),
    resolver: r.resolver as string,
    contentHash: r.content_hash as string,
    createdAt: r.created_at as string,
  }));

  return c.json({
    events,
    edges: mappedEdges,
    // The cursor is the max id ACTUALLY RETURNED, so a client that pages
    // through a backlog never skips the tail of a truncated page.
    cursor: envelopeCursor(events, mappedEdges),
    hasMore: events.length === PAGE_LIMIT || mappedEdges.length === PAGE_LIMIT,
  });
});

/**
 * SSE live tail. Polls the log on an interval rather than hooking the write
 * path: the relay may be multi-process, and a write handled by another
 * instance would be invisible to an in-memory bus. Postgres LISTEN/NOTIFY
 * replaces this when the relay moves off SQLite (§4.7).
 */
relayRouter.get("/v1/events/stream", (c) => {
  const denied = authorize(c);
  if (denied) return c.json({ error: denied }, denied === "unauthorized" ? 401 : 503);

  const workspace = c.req.query("workspace") ?? "local";
  const project = c.req.query("project") ?? "local";
  let cursor = c.req.query("since") ?? "";
  const intervalMs = Number(process.env["AGENT_TRAIL_RELAY_POLL_MS"] ?? 1000);

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { /* closed */ } };
      send(`event: connected\ndata: ${JSON.stringify({ since: cursor })}\n\n`);

      const tick = () => {
        try {
          const db = getDb();
          const rows = db.query(
            `SELECT * FROM knowledge_events
              WHERE workspace_id = ? AND project_id = ? AND (? = '' OR id > ?)
              ORDER BY id LIMIT 100`,
          ).all(workspace, project, cursor, cursor) as RawRow[];
          if (rows.length) {
            for (const row of rows) {
              send(`event: knowledge\ndata: ${JSON.stringify(rowToEvent(row))}\n\n`);
            }
            cursor = rows[rows.length - 1]!.id;
          } else {
            // SSE comment keepalive — holds proxies open without emitting a
            // parseable event a client would mistake for data.
            send(": keepalive\n\n");
          }
        } catch { /* a transient DB error must not kill the stream */ }
      };

      const timer = setInterval(tick, intervalMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
      c.req.raw.signal?.addEventListener("abort", () => {
        clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
