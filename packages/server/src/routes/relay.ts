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
// ── Auth ────────────────────────────────────────────────────────────────────
// Per-user tokens scoped to one workspace, with roles (§5.1). The workspace a
// request may touch is DERIVED FROM THE CREDENTIAL — never read from the
// request body or query string. See workspace.ts.
//
// INVENTARIUM_RELAY_TOKEN survives as a single-workspace bootstrap secret,
// pinned to INVENTARIUM_RELAY_WORKSPACE and granted `member` (not `admin`), so
// it can carry a self-hosted install without becoming a master key.

import { Hono } from "hono";
import { getDb } from "../db.js";
import {
  applyIncoming, envelopeCursor,
} from "../../../core/src/knowledge/sync.ts";
import { hasEdgeTable } from "../../../core/src/knowledge/edges.ts";
import { rowToEvent, type RawRow } from "../../../core/src/knowledge/store.ts";
import {
  ROLES, addMember, authorize, bearerFrom, listMembers, removeMember,
  statusForFailure, upsertUser, type AuthContext, type Role,
} from "../../../core/src/knowledge/workspace.ts";

export const relayRouter = new Hono();

const PAGE_LIMIT = 500;

type AuthOk = { ok: true; ctx: AuthContext };
type AuthErr = { ok: false; status: 401 | 403 | 503; body: { error: string } };

/**
 * Resolve the caller's identity and the workspace their token is scoped to.
 *
 * The workspace is DERIVED from the credential, never read from the request.
 * The previous shared-secret model accepted a `workspaceId` in the body and
 * believed it, so one token could read or write every workspace on the relay.
 *
 * `INVENTARIUM_RELAY_TOKEN` is still honoured for single-workspace self-hosting,
 * but it is now pinned to `INVENTARIUM_RELAY_WORKSPACE` (default "local") and
 * therefore cannot reach any other workspace. It grants `member`, not `admin` —
 * a bootstrap secret should never be able to change who else has access.
 */
function requireAuth(
  c: { req: { header: (n: string) => string | undefined } },
  required: Role,
): AuthOk | AuthErr {
  const presented = bearerFrom(c.req.header("authorization"));
  const legacy = process.env["INVENTARIUM_RELAY_TOKEN"]?.trim();
  const legacyWorkspace = process.env["INVENTARIUM_RELAY_WORKSPACE"]?.trim() || "local";

  if (legacy && presented && presented.length === legacy.length && presented === legacy) {
    if (required === "admin" || required === "owner") {
      return { ok: false, status: 403, body: { error: "the bootstrap relay token cannot administer members — issue a real token" } };
    }
    return {
      ok: true,
      ctx: {
        user: { id: "bootstrap", externalId: "bootstrap", displayName: "Bootstrap Token", email: null },
        workspaceId: legacyWorkspace,
        role: "member",
        tokenId: "bootstrap",
      },
    };
  }

  const res = authorize(getDb(), presented, required);
  if (res.ok) return { ok: true, ctx: res.ctx };

  // A relay with no credential system configured at all should say so rather
  // than look like a rejected login.
  if (res.reason === "no_token" && !legacy && !anyTokensExist()) {
    return { ok: false, status: 503, body: { error: "relay has no credentials configured — run `inventarium workspace token create`" } };
  }
  return { ok: false, status: statusForFailure(res.reason), body: { error: res.reason } };
}

function anyTokensExist(): boolean {
  try {
    return !!getDb().query("SELECT 1 FROM api_tokens LIMIT 1").get();
  } catch {
    return false;
  }
}

relayRouter.post("/v1/events", async (c) => {
  // Writing knowledge requires `member`; a viewer can read a team's log
  // without being able to inject rulings into it.
  const auth = requireAuth(c, "member");
  if (!auth.ok) return c.json(auth.body, auth.status);

  const body = await c.req.json<{ projectId?: string; events?: unknown[]; edges?: unknown[] }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);

  const events = Array.isArray(body.events) ? body.events : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];
  if (events.length > PAGE_LIMIT * 4 || edges.length > PAGE_LIMIT * 4) {
    return c.json({ error: "batch too large" }, 413);
  }

  // Stamp every row with the workspace the TOKEN is scoped to, overriding
  // whatever the payload claimed. Trusting a client-supplied workspaceId was
  // the hole: a member of workspace A could write into workspace B simply by
  // saying so. Rows are rewritten rather than rejected so a client whose
  // config drifted still syncs into its own workspace instead of silently
  // failing.
  const ws = auth.ctx.workspaceId;
  const scope = (rows: unknown[]) => rows.map((r) =>
    r && typeof r === "object" ? { ...(r as Record<string, unknown>), workspaceId: ws } : r);

  // applyIncoming is idempotent on content_hash, so a client retrying after a
  // dropped response re-sends safely — the append-only log's whole point.
  const applied = applyIncoming(getDb(), { events: scope(events), edges: scope(edges) });
  return c.json({
    inserted: { events: applied.events, edges: applied.edges },
    rejected: applied.rejected,
    cursor: envelopeCursor(events as Array<{ id: string }>, edges as Array<{ id: string }>),
  });
});

relayRouter.get("/v1/events", (c) => {
  const auth = requireAuth(c, "viewer");
  if (!auth.ok) return c.json(auth.body, auth.status);

  const since = c.req.query("since") ?? "";
  // Workspace comes from the credential. A `?workspace=` query param is
  // ignored entirely rather than validated, so there is no code path in which
  // a caller's assertion about scope can be believed.
  const workspace = auth.ctx.workspaceId;
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
  const auth = requireAuth(c, "viewer");
  if (!auth.ok) return c.json(auth.body, auth.status);

  const workspace = auth.ctx.workspaceId;
  const project = c.req.query("project") ?? "local";
  let cursor = c.req.query("since") ?? "";
  const intervalMs = Number(process.env["INVENTARIUM_RELAY_POLL_MS"] ?? 1000);

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

// ── Workspace administration ────────────────────────────────────────────────
// Membership changes require `admin`. Deliberately NOT reachable with the
// bootstrap token: a secret in an env var should be able to carry data, never
// to grant a stranger access.

relayRouter.get("/v1/workspace", (c) => {
  const auth = requireAuth(c, "viewer");
  if (!auth.ok) return c.json(auth.body, auth.status);
  return c.json({
    workspaceId: auth.ctx.workspaceId,
    you: { ...auth.ctx.user, role: auth.ctx.role },
    members: listMembers(getDb(), auth.ctx.workspaceId),
  });
});

relayRouter.post("/v1/workspace/members", async (c) => {
  const auth = requireAuth(c, "admin");
  if (!auth.ok) return c.json(auth.body, auth.status);

  const body = await c.req.json<{ externalId?: string; displayName?: string; email?: string; role?: Role }>()
    .catch(() => null);
  if (!body?.externalId || !body.displayName) {
    return c.json({ error: "externalId and displayName are required" }, 400);
  }
  if (body.role && !ROLES.includes(body.role)) {
    return c.json({ error: `role must be one of ${ROLES.join(", ")}` }, 400);
  }

  const db = getDb();
  const user = upsertUser(db, { externalId: body.externalId, displayName: body.displayName, email: body.email ?? null });
  addMember(db, auth.ctx.workspaceId, user.id, body.role ?? "member");
  return c.json({ user, role: body.role ?? "member" }, 201);
});

relayRouter.delete("/v1/workspace/members/:userId", (c) => {
  const auth = requireAuth(c, "admin");
  if (!auth.ok) return c.json(auth.body, auth.status);
  const target = c.req.param("userId");

  // An owner must not be able to lock themselves out and strand the workspace.
  if (target === auth.ctx.user.id) {
    return c.json({ error: "you cannot remove yourself — have another admin do it" }, 400);
  }
  // Removing membership also revokes that user's tokens for this workspace,
  // so access ends now rather than at the next expiry.
  removeMember(getDb(), auth.ctx.workspaceId, target);
  return c.json({ removed: target });
});
