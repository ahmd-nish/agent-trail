// Knowledge graph API for the visual explorer.
//
// Serves the JOIN (§J) as something a human can look at: knowledge events on
// one side, the code they govern on the other, and the `governs` /
// `produced_by` edges between them.
//
// Shaped for exploration rather than bulk export:
//   - hard node/edge caps, because a real log will outgrow any canvas
//   - server-side filtering (type, actor, search, focus) so the browser is
//     never asked to hold the whole graph to show a corner of it
//   - a `focus` mode that returns one node's neighbourhood, which is how you
//     actually read a graph this dense

import { Hono } from "hono";
import { getDb } from "../db.js";
import { hasEdgeTable } from "../../../core/src/knowledge/edges.ts";
import { rowToEvent, type RawRow } from "../../../core/src/knowledge/store.ts";
import { parseUrn } from "../../../core/src/knowledge/code-index.ts";

export const knowledgeGraphRouter = new Hono();

const MAX_NODES = 400;

export interface GraphNode {
  id: string;
  kind: "event" | "file" | "module" | "symbol";
  label: string;
  /** Event fields, present only on event nodes. */
  eventType?: string;
  actor?: string;
  confidence?: string;
  validFrom?: string;
  body?: string;
  paths?: string[];
  taskId?: string | null;
  /** Degree, so the UI can size and rank without a second pass. */
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  weight: number;
  resolver: string;
}

function codeNodeLabel(urn: string): { kind: GraphNode["kind"]; label: string } {
  const parsed = parseUrn(urn);
  if (!parsed) return { kind: "file", label: urn };
  if (parsed.kind === "sym") return { kind: "symbol", label: `${parsed.name}()` };
  if (parsed.kind === "module") return { kind: "module", label: parsed.path };
  return { kind: "file", label: parsed.path.split("/").slice(-1)[0] || parsed.path };
}

knowledgeGraphRouter.get("/knowledge/graph", (c) => {
  const db = getDb();
  if (!hasEdgeTable(db)) {
    return c.json({ nodes: [], edges: [], truncated: false, reason: "no knowledge_edges table yet" });
  }

  const type = c.req.query("type");        // filter by event type
  const actor = c.req.query("actor");
  const q = (c.req.query("q") ?? "").trim();
  const focus = c.req.query("focus");      // a node id to centre on
  const limit = Math.min(Number(c.req.query("limit") ?? MAX_NODES), MAX_NODES);

  const where: string[] = ["e.superseded_by IS NULL"];
  const params: unknown[] = [];
  if (type) { where.push("e.type = ?"); params.push(type); }
  if (actor) { where.push("e.actor_name = ?"); params.push(actor); }
  if (q) { where.push("(e.subject LIKE ? OR e.body LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }

  // Focus mode: restrict to the neighbourhood of one node. For a code node
  // that means the events governing it; for an event node, that event plus
  // everything it touches.
  if (focus) {
    if (focus.startsWith("kev:")) {
      where.push("e.id = ?");
      params.push(focus.slice(4));
    } else {
      where.push(`e.id IN (SELECT substr(g2.src, 5) FROM knowledge_edges g2 WHERE g2.dst = ?)`);
      params.push(focus);
    }
  }

  let rows: Array<RawRow & { edge_dst: string; edge_kind: string; edge_weight: number; edge_resolver: string }>;
  try {
    rows = db.query(
      `SELECT e.*, g.dst AS edge_dst, g.kind AS edge_kind,
              g.weight AS edge_weight, g.resolver AS edge_resolver
         FROM knowledge_events e
         JOIN knowledge_edges g ON g.src = 'kev:' || e.id
        WHERE ${where.join(" AND ")}
        ORDER BY e.valid_from DESC
        LIMIT ?`,
    ).all(...params, limit * 4) as typeof rows;
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let truncated = false;

  for (const r of rows) {
    const eventId = `kev:${r.id}`;
    if (!nodes.has(eventId)) {
      if (nodes.size >= limit) { truncated = true; continue; }
      const ev = rowToEvent(r);
      nodes.set(eventId, {
        id: eventId,
        kind: "event",
        label: ev.subject,
        eventType: ev.type,
        actor: ev.actorName,
        confidence: ev.confidence,
        validFrom: ev.validFrom,
        // Trimmed: the panel fetches nothing extra, but a 4KB contract body
        // per node would dominate the payload.
        body: ev.body.slice(0, 600),
        paths: ev.paths,
        taskId: ev.taskId,
        degree: 0,
      });
    }
    if (!nodes.has(r.edge_dst)) {
      if (nodes.size >= limit) { truncated = true; continue; }
      const { kind, label } = codeNodeLabel(r.edge_dst);
      nodes.set(r.edge_dst, { id: r.edge_dst, kind, label, degree: 0 });
    }
    if (!nodes.has(eventId) || !nodes.has(r.edge_dst)) continue;

    edges.push({
      source: eventId, target: r.edge_dst,
      kind: r.edge_kind, weight: r.edge_weight, resolver: r.edge_resolver,
    });
    nodes.get(eventId)!.degree++;
    nodes.get(r.edge_dst)!.degree++;
  }

  return c.json({
    nodes: [...nodes.values()],
    edges,
    truncated,
    // Facets for the filter UI, computed over the WHOLE log rather than the
    // returned slice — otherwise filtering would hide the options that would
    // widen the view again.
    facets: facets(db),
  });
});

function facets(db: ReturnType<typeof getDb>) {
  try {
    const types = db.query(
      "SELECT type, COUNT(*) AS n FROM knowledge_events WHERE superseded_by IS NULL GROUP BY type ORDER BY n DESC",
    ).all() as Array<{ type: string; n: number }>;
    const actors = db.query(
      "SELECT actor_name, COUNT(*) AS n FROM knowledge_events WHERE superseded_by IS NULL GROUP BY actor_name ORDER BY n DESC LIMIT 25",
    ).all() as Array<{ actor_name: string; n: number }>;
    return {
      types: types.map((t) => ({ value: t.type, count: t.n })),
      actors: actors.map((a) => ({ value: a.actor_name, count: a.n })),
    };
  } catch {
    return { types: [], actors: [] };
  }
}

/** Full detail for one event — the panel's "open" action. */
knowledgeGraphRouter.get("/knowledge/events/:id", (c) => {
  const db = getDb();
  const row = db.query("SELECT * FROM knowledge_events WHERE id = ?").get(c.req.param("id")) as RawRow | null;
  if (!row) return c.json({ error: "not found" }, 404);

  const event = rowToEvent(row);
  let neighbours: Array<{ dst: string; kind: string; resolver: string }> = [];
  if (hasEdgeTable(db)) {
    neighbours = db.query("SELECT dst, kind, resolver FROM knowledge_edges WHERE src = ?")
      .all(`kev:${event.id}`) as typeof neighbours;
  }
  return c.json({ event, neighbours });
});
