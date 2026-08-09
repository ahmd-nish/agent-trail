import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { append } from "../../core/src/knowledge/store.ts";
import type { NewKnowledgeEvent } from "../../core/src/knowledge/types.ts";

// The visual explorer's API. Shaped for exploration, not bulk export: filters
// and focus run server-side so the browser is never asked to hold the whole
// graph in order to show a corner of it.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

function freeport(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.once("listening", () => {
      const a = srv.address();
      if (!a || typeof a === "string") { srv.close(); reject(new Error("no port")); return; }
      const p = a.port; srv.close(() => resolve(p));
    });
    srv.listen(0, "127.0.0.1");
  });
}

async function waitForHealth(port: number, ms = 20000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return true; }
    catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

interface GraphResp {
  nodes: Array<{ id: string; kind: string; label: string; degree: number; eventType?: string; actor?: string }>;
  edges: Array<{ source: string; target: string; kind: string }>;
  truncated: boolean;
  facets: { types: Array<{ value: string; count: number }>; actors: Array<{ value: string; count: number }> };
}

describe("knowledge graph API (visual explorer)", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let dbPath = "";

  const ev = (o: Partial<NewKnowledgeEvent>): NewKnowledgeEvent => ({
    workspaceId: "local", projectId: "demo",
    actorKind: "human", actorId: "x", actorName: "X",
    taskId: null, executionId: null,
    type: "decision", scope: "project",
    subject: "s", body: "b", paths: [], confidence: "ruling", supersedes: null,
    ...o,
  });

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-graph-"));
    dbPath = join(tmp, "at.db");
    port = await freeport();
    const { AGENT_TRAIL_DB_PATH: _a, VIBE_BOARD_DB_PATH: _b, ...clean } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...clean, AGENT_TRAIL_PORT: String(port), AGENT_TRAIL_ROOT: tmp,
        AGENT_TRAIL_DB_PATH: dbPath, AGENT_TRAIL_SKIP_RUNNER: "1",
        AGENT_TRAIL_SKIP_AUTOSYNC: "1", AGENT_TRAIL_SKIP_HYDRATE: "1",
      },
      stdio: "ignore",
    });
    if (!await waitForHealth(port)) throw new Error("graph server did not start");

    // Seed after boot so the server owns schema creation.
    const db = new Database(dbPath);
    append(db, ev({ actorId: "sarah", actorName: "Sarah", type: "decision", subject: "sessions are sha256-hashed", paths: ["src/auth/session.ts"] }));
    append(db, ev({ actorId: "nish", actorName: "Nish", type: "convention", subject: "all IO through the repository layer", paths: ["src/db"] }));
    append(db, ev({ actorId: "cc", actorName: "Claude Code", type: "failed_attempt", confidence: "observed", subject: "null-guard failed twice", paths: ["src/api.ts"] }));
    append(db, ev({
      actorId: "cc", actorName: "Claude Code", type: "artifact_summary", confidence: "observed",
      subject: "built the session module", paths: ["src/auth/session.ts"],
      body: JSON.stringify({
        type: "capability_contract", taskId: "t-1", baseSha: null,
        provides: { modules: ["src/auth/session.ts"], exports: [], routes: [], tables: [], env: [], events: [] },
        invariants: [], deliberatelyNotDone: [], entrypoints: ["src/auth/session.ts:createSession"],
      }),
    }));
    db.close();
  }, 40000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const graph = async (qs = ""): Promise<GraphResp> =>
    await (await fetch(`http://localhost:${port}/api/knowledge/graph${qs}`)).json() as GraphResp;

  test("returns knowledge nodes joined to the code they govern", async () => {
    const g = await graph();
    const kinds = new Set(g.nodes.map((n) => n.kind));
    expect(kinds.has("event")).toBe(true);
    expect(kinds.has("file")).toBe(true);
    // A directory-scoped fact becomes a module node; a contract entrypoint
    // becomes a symbol node via its produced_by edge.
    expect(kinds.has("module")).toBe(true);
    expect(kinds.has("symbol")).toBe(true);
    expect(g.edges.length).toBeGreaterThan(0);
  });

  test("degree is precomputed so the UI can size nodes without a second pass", async () => {
    const g = await graph();
    const session = g.nodes.find((n) => n.label === "session.ts")!;
    // Governed by a decision AND produced by a contract.
    expect(session.degree).toBeGreaterThanOrEqual(2);
  });

  test("code node labels are readable, not raw URNs", async () => {
    const g = await graph();
    expect(g.nodes.some((n) => n.label === "session.ts")).toBe(true);
    expect(g.nodes.some((n) => n.label === "createSession()")).toBe(true);
    expect(g.nodes.every((n) => !n.label.startsWith("file:"))).toBe(true);
  });

  test("filters by event type", async () => {
    const g = await graph("?type=decision");
    const events = g.nodes.filter((n) => n.kind === "event");
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("decision");
  });

  test("filters by actor", async () => {
    const g = await graph("?actor=Sarah");
    expect(g.nodes.filter((n) => n.kind === "event").every((n) => n.actor === "Sarah")).toBe(true);
  });

  test("full-text search narrows the graph", async () => {
    const g = await graph("?q=repository");
    const events = g.nodes.filter((n) => n.kind === "event");
    expect(events.length).toBe(1);
    expect(events[0]!.label).toContain("repository layer");
  });

  test("focus on a code node returns only what governs it", async () => {
    const g = await graph("?focus=" + encodeURIComponent("file:src/auth/session.ts"));
    const labels = g.nodes.filter((n) => n.kind === "event").map((n) => n.label);
    expect(labels).toContain("sessions are sha256-hashed");
    // The unrelated api.ts failure must not be dragged in.
    expect(labels).not.toContain("null-guard failed twice");
  });

  test("facets are computed over the whole log, not the filtered slice", async () => {
    // Otherwise filtering would hide the very options that widen the view again.
    const g = await graph("?type=decision");
    expect(g.facets.types.length).toBeGreaterThan(1);
    expect(g.facets.actors.length).toBeGreaterThan(1);
  });

  test("superseded events are absent from the graph", async () => {
    const db = new Database(dbPath);
    const first = append(db, ev({ subject: "old ruling", paths: ["src/x.ts"] })).event;
    append(db, ev({ subject: "new ruling", paths: ["src/x.ts"], supersedes: first.id }));
    db.close();

    const labels = (await graph()).nodes.map((n) => n.label);
    expect(labels).toContain("new ruling");
    expect(labels).not.toContain("old ruling");
  });

  test("event detail endpoint returns the full body and its neighbours", async () => {
    const g = await graph("?q=session module");
    const node = g.nodes.find((n) => n.kind === "event")!;
    const res = await fetch(`http://localhost:${port}/api/knowledge/events/${node.id.slice(4)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { event: { subject: string }; neighbours: unknown[] };
    expect(body.event.subject).toBe("built the session module");
    expect(body.neighbours.length).toBeGreaterThan(0);
  });

  test("an unknown event id is a 404, not a crash", async () => {
    const res = await fetch(`http://localhost:${port}/api/knowledge/events/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
