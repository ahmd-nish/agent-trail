import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCodeIndex, symbolUrn, type CodeIndex } from "./code-index.ts";
import {
  appendEdge, blastRadius, emitContractEdges, eventUrn, knowledgeGoverning,
  provenanceChain, resolveSymbolEdges,
} from "./edges.ts";
import {
  KNOWLEDGE_EDGES_DDL, KNOWLEDGE_EDGES_INDEXES,
  KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES,
} from "./schema.ts";
import { append } from "./store.ts";
import type { NewKnowledgeEvent } from "./types.ts";

function freshDb(withEdges = true): Database {
  const db = new Database(":memory:");
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) db.exec(s);
  if (withEdges) {
    db.exec(KNOWLEDGE_EDGES_DDL);
    for (const s of KNOWLEDGE_EDGES_INDEXES) db.exec(s);
  }
  return db;
}

function ev(o: Partial<NewKnowledgeEvent> = {}): NewKnowledgeEvent {
  return {
    workspaceId: "local", projectId: "test",
    actorKind: "human", actorId: "sarah@x", actorName: "Sarah",
    taskId: null, executionId: null,
    type: "decision", scope: "project",
    subject: "sessions are sha256-hashed", body: "raw tokens are never persisted",
    paths: [], confidence: "ruling", supersedes: null,
    ...o,
  };
}

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "at-edges-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content, "utf-8");
  }
  return root;
}

describe("§J auto-population", () => {
  test("append() emits exactly one governs edge per path", () => {
    const db = freshDb();
    const { event } = append(db, ev({ paths: ["packages/core/src/auth.ts"] }));
    const rows = db.query("SELECT dst, kind, weight, resolver FROM knowledge_edges WHERE src = ?")
      .all(eventUrn(event.id)) as Array<{ dst: string; kind: string; weight: number; resolver: string }>;

    // ONE edge — the URN the path actually is. Ancestors are a read-side
    // expansion; emitting them here would over-claim across sibling files.
    expect(rows.map((r) => r.dst)).toEqual(["file:packages/core/src/auth.ts"]);
    expect(rows[0]!.kind).toBe("governs");
    expect(rows[0]!.weight).toBe(1.0);
    expect(rows[0]!.resolver).toBe("paths");
  });

  test("nobody types anything — an event with no paths yields no edges", () => {
    const db = freshDb();
    const { event } = append(db, ev({ paths: [] }));
    expect(db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE src = ?")
      .get(eventUrn(event.id))).toEqual({ n: 0 });
  });

  test("edges are grow-only — re-appending the same event does not duplicate", () => {
    const db = freshDb();
    append(db, ev({ paths: ["a/b.ts"] }));
    append(db, ev({ paths: ["a/b.ts"] }));   // identical -> dedupes at the event layer
    const { n } = db.query("SELECT COUNT(*) AS n FROM knowledge_edges").get() as { n: number };
    expect(n).toBe(1);   // file:a/b.ts
  });

  test("appendEdge is idempotent on (src, dst, kind)", () => {
    const db = freshDb();
    const base = { workspaceId: "local", projectId: "test", src: "kev:x", dst: "file:a.ts", kind: "governs" as const, resolver: "paths" };
    expect(appendEdge(db, base)).toBe(true);
    expect(appendEdge(db, base)).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM knowledge_edges").get()).toEqual({ n: 1 });
  });

  test("an event append still succeeds when the edges table does not exist", () => {
    // A DB predating migration v26 must not lose events. This is the property
    // that lets §J ship without a coordinated upgrade.
    const db = freshDb(false);
    const { event, inserted } = append(db, ev({ paths: ["a/b.ts"] }));
    expect(inserted).toBe(true);
    expect(event.paths).toEqual(["a/b.ts"]);
  });

  test("a capability contract emits produced_by edges for modules and entrypoints", () => {
    const db = freshDb();
    const contract = JSON.stringify({
      type: "capability_contract",
      taskId: "t-1", baseSha: null,
      provides: { modules: ["src/session.ts"], exports: [], routes: [], tables: [], env: [], events: [] },
      invariants: [], deliberatelyNotDone: [],
      entrypoints: ["src/session.ts:createSession"],
    });
    const { event } = append(db, ev({ type: "artifact_summary", body: contract, paths: [] }));
    const rows = db.query("SELECT dst, kind FROM knowledge_edges WHERE src = ? AND kind = 'produced_by'")
      .all(eventUrn(event.id)) as Array<{ dst: string; kind: string }>;
    expect(rows.map((r) => r.dst).sort()).toEqual([
      "file:src/session.ts",
      "sym:src/session.ts#createSession",
    ]);
  });

  test("a prose artifact_summary emits no contract edges", () => {
    const db = freshDb();
    const { event } = append(db, ev({ type: "artifact_summary", body: "Modified: a.ts, b.ts", paths: [] }));
    expect(emitContractEdges(db, event)).toBe(0);
  });
});

describe("Q1 — knowledgeGoverning", () => {
  test("a task inherits a ruling scoped to a parent module", () => {
    const db = freshDb();
    append(db, ev({ subject: "all IO goes through the adapter", paths: ["packages/core"] }));
    const hits = knowledgeGoverning(db, ["packages/core/src/deep/nested/file.ts"]);
    expect(hits.length).toBe(1);
    expect(hits[0]!.event.subject).toBe("all IO goes through the adapter");
    // A pathless leaf is treated as a module, and the read side expands the
    // consumer's file up through its ancestors to meet it.
    expect(hits[0]!.via).toBe("module:packages/core");
  });

  test("superseded events are excluded", () => {
    const db = freshDb();
    const first = append(db, ev({ subject: "use callbacks", paths: ["a.ts"] })).event;
    append(db, ev({ subject: "use promises", paths: ["a.ts"], supersedes: first.id }));
    const hits = knowledgeGoverning(db, ["a.ts"]);
    expect(hits.map((h) => h.event.subject)).toEqual(["use promises"]);
  });

  test("a human ruling outranks an LLM inference on the same file", () => {
    const db = freshDb();
    append(db, ev({ subject: "inferred thing", paths: ["a.ts"], confidence: "inferred" }));
    append(db, ev({ subject: "the ruling", paths: ["a.ts"], confidence: "ruling" }));
    const hits = knowledgeGoverning(db, ["a.ts"]);
    expect(hits[0]!.event.subject).toBe("the ruling");
  });

  test("unrelated files return nothing", () => {
    const db = freshDb();
    append(db, ev({ paths: ["packages/web/ui.ts"] }));
    expect(knowledgeGoverning(db, ["services/api/main.go"])).toEqual([]);
  });

  test("respects the hard budget — traversal breadth is never a reason to send more", () => {
    const db = freshDb();
    for (let i = 0; i < 30; i++) {
      append(db, ev({ subject: `fact ${i}`, body: `body ${i}`, paths: ["a.ts"] }));
    }
    expect(knowledgeGoverning(db, ["a.ts"], { limit: 5 }).length).toBe(5);
  });

  test("returns empty when the edges table is absent", () => {
    const db = freshDb(false);
    append(db, ev({ paths: ["a.ts"] }));
    expect(knowledgeGoverning(db, ["a.ts"])).toEqual([]);
  });
});

describe("Q2 — blastRadius", () => {
  test("reaches knowledge attached to a CALLER of the symbol being changed", async () => {
    // The query no single tool answers: `api.ts` is not in the task's
    // footprint and shares no text with it. It is reached purely because the
    // code graph says it calls createSession, and the knowledge graph has a
    // prior failure recorded against it.
    const root = fixtureRepo({
      "src/session.ts": "export function createSession(userId: string) { return userId; }\n",
      "src/api.ts": `import { createSession } from "./session.ts";\ncreateSession("u1");\n`,
    });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts", "src/api.ts"] });
    const db = freshDb();
    append(db, ev({
      type: "failed_attempt", actorName: "Sarah",
      subject: "api.ts null-guard failed here", paths: ["src/api.ts"], confidence: "observed",
    }));

    const direct = knowledgeGoverning(db, ["src/session.ts"]);
    expect(direct).toEqual([]);            // nothing governs the file itself

    const hits = await blastRadius(db, ["src/session.ts"], index);
    expect(hits.length).toBe(1);
    expect(hits[0]!.event.subject).toBe("api.ts null-guard failed here");
    expect(hits[0]!.hops).toBe(1);         // reached through the code graph
    rmSync(root, { recursive: true, force: true });
  });

  test("direct hits outrank hits reached through callers", async () => {
    const root = fixtureRepo({
      "src/session.ts": "export function createSession(u: string) { return u; }\n",
      "src/api.ts": `import { createSession } from "./session.ts";\ncreateSession("u");\n`,
    });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts", "src/api.ts"] });
    const db = freshDb();
    append(db, ev({ subject: "direct", paths: ["src/session.ts"], confidence: "observed" }));
    append(db, ev({ subject: "reached", paths: ["src/api.ts"], confidence: "observed" }));

    const hits = await blastRadius(db, ["src/session.ts"], index);
    expect(hits[0]!.event.subject).toBe("direct");
    expect(hits[0]!.hops).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("degrades to Q1 when the adapter throws", async () => {
    const db = freshDb();
    append(db, ev({ subject: "direct fact", paths: ["a.ts"] }));
    const broken: CodeIndex = {
      name: "broken", available: async () => true,
      symbolsInPaths: async () => { throw new Error("backend died"); },
      findSymbol: async () => [], getSignature: async () => null,
      whoCalls: async () => [], indexedAtSha: async () => null,
    };
    // Structural expansion is best-effort; the asserted half still answers.
    const hits = await blastRadius(db, ["a.ts"], broken);
    expect(hits.map((h) => h.event.subject)).toEqual(["direct fact"]);
  });
});

describe("Q3 — provenanceChain", () => {
  test("file -> contract that produced it -> decision that shaped it -> who", () => {
    const db = freshDb();
    append(db, ev({
      type: "artifact_summary", actorKind: "agent", actorName: "Claude Code",
      subject: "built the session module", paths: [],
      body: JSON.stringify({
        type: "capability_contract", taskId: "t-1", baseSha: null,
        provides: { modules: ["src/session.ts"], exports: [], routes: [], tables: [], env: [], events: [] },
        invariants: [], deliberatelyNotDone: [], entrypoints: [],
      }),
    }));
    append(db, ev({
      type: "decision", actorName: "Nish",
      subject: "sessions must be sha256, never raw", paths: ["src/session.ts"], confidence: "ruling",
    }));

    const chain = provenanceChain(db, "src/session.ts");
    const kinds = new Set(chain.map((c) => c.edgeKind));
    expect(kinds.has("produced_by")).toBe(true);
    expect(kinds.has("governs")).toBe(true);
    // "Who" falls out of the rows — the actor is already on every event.
    expect(chain.map((c) => c.event.actorName).sort()).toEqual(["Claude Code", "Nish"]);
  });
});

describe("resolveSymbolEdges (§4.2 step 3)", () => {
  test("emits a sym: edge per resolved symbol, weighted by resolver", async () => {
    const root = fixtureRepo({
      "src/session.ts": "export function createSession(u: string) { return u; }\nexport class Store {}\n",
    });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const db = freshDb();
    const { event } = append(db, ev({ paths: ["src/session.ts"] }));

    const n = await resolveSymbolEdges(db, event, index);
    expect(n).toBe(2);
    const rows = db.query("SELECT dst, resolver, weight FROM knowledge_edges WHERE dst LIKE 'sym:%'")
      .all() as Array<{ dst: string; resolver: string; weight: number }>;
    expect(rows.map((r) => r.dst).sort()).toEqual([
      symbolUrn("src/session.ts", "Store"),
      symbolUrn("src/session.ts", "createSession"),
    ]);
    // A regex-resolved edge is weaker evidence than a type-aware one.
    expect(rows[0]!.resolver).toBe("native");
    expect(rows[0]!.weight).toBe(0.6);
    rmSync(root, { recursive: true, force: true });
  });

  test("a task inherits a ruling via a sym: edge, not a path string match", async () => {
    // §J exit criterion. The consumer's path list does NOT contain the file the
    // ruling was attached to — the join happens on the symbol.
    const root = fixtureRepo({
      "src/session.ts": "export function createSession(u: string) { return u; }\n",
    });
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const db = freshDb();
    const { event } = append(db, ev({
      subject: "createSession must never persist raw tokens", paths: ["src/session.ts"],
    }));
    await resolveSymbolEdges(db, event, index);

    // Query by the SYMBOL URN alone.
    const rows = db.query(
      `SELECT e.subject FROM knowledge_events e
         JOIN knowledge_edges g ON g.src = 'kev:' || e.id
        WHERE g.dst = ?`,
    ).all(symbolUrn("src/session.ts", "createSession")) as Array<{ subject: string }>;
    expect(rows.map((r) => r.subject)).toEqual(["createSession must never persist raw tokens"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("is a no-op rather than a throw when the adapter fails", async () => {
    const db = freshDb();
    const { event } = append(db, ev({ paths: ["a.ts"] }));
    const broken: CodeIndex = {
      name: "broken", available: async () => true,
      symbolsInPaths: async () => { throw new Error("nope"); },
      findSymbol: async () => [], getSignature: async () => null,
      whoCalls: async () => [], indexedAtSha: async () => null,
    };
    expect(await resolveSymbolEdges(db, event, broken)).toBe(0);
  });
});
