import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCodeIndex } from "./code-index.ts";
import { formatRetrievedFacts, retrieveForTask } from "./retrieval.ts";
import {
  KNOWLEDGE_EDGES_DDL, KNOWLEDGE_EDGES_INDEXES, KNOWLEDGE_EVENTS_DDL,
  KNOWLEDGE_EVENTS_FTS, KNOWLEDGE_EVENTS_FTS_TRIGGERS, KNOWLEDGE_EVENTS_INDEXES,
} from "./schema.ts";
import { append } from "./store.ts";
import type { NewKnowledgeEvent } from "./types.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) db.exec(s);
  db.exec(KNOWLEDGE_EDGES_DDL);
  for (const s of KNOWLEDGE_EDGES_INDEXES) db.exec(s);
  db.exec(KNOWLEDGE_EVENTS_FTS);
  for (const s of KNOWLEDGE_EVENTS_FTS_TRIGGERS) db.exec(s);
  return db;
}

function ev(o: Partial<NewKnowledgeEvent> = {}): NewKnowledgeEvent {
  return {
    workspaceId: "local", projectId: "test",
    actorKind: "human", actorId: "sarah@x", actorName: "Sarah",
    taskId: null, executionId: null,
    type: "decision", scope: "project",
    subject: "a fact", body: "details",
    paths: [], confidence: "ruling", supersedes: null,
    ...o,
  };
}

describe("§6 hybrid retrieval", () => {
  test("EXIT CRITERION — a governed file yields the ruling with zero text overlap", async () => {
    // The whole point. "add session expiry" shares no word with "all database
    // access goes through the repository layer", but the ruling is attached to
    // a file the task will touch.
    const db = freshDb();
    append(db, ev({
      subject: "all database access goes through the repository layer",
      body: "never call the driver directly",
      paths: ["src/session.ts"],
    }));

    const facts = await retrieveForTask(db, {
      text: "add expiry handling to login flows",
      paths: ["src/session.ts"],
    });

    expect(facts.length).toBe(1);
    expect(facts[0]!.sources).toEqual(["structural"]);
    expect(facts[0]!.event.subject).toContain("repository layer");
  });

  test("a fact reached BOTH ways outranks one reached either way alone", async () => {
    const db = freshDb();
    append(db, ev({ subject: "session expiry must be enforced server side", paths: ["src/session.ts"] }));
    append(db, ev({ subject: "session expiry is tricky", paths: [] }));                // lexical only
    append(db, ev({ subject: "unrelated styling rule", paths: ["src/session.ts"] }));  // structural only

    const facts = await retrieveForTask(db, {
      text: "session expiry",
      paths: ["src/session.ts"],
    });
    expect(facts[0]!.event.subject).toBe("session expiry must be enforced server side");
    expect(facts[0]!.sources.sort()).toEqual(["lexical", "structural"]);
  });

  test("a human ruling outranks an observed fact of equal reach", async () => {
    const db = freshDb();
    append(db, ev({ subject: "observed thing here", paths: ["a.ts"], confidence: "observed" }));
    append(db, ev({ subject: "the ruling here", paths: ["a.ts"], confidence: "ruling" }));
    const facts = await retrieveForTask(db, { text: "", paths: ["a.ts"] });
    expect(facts[0]!.event.subject).toBe("the ruling here");
  });

  test("observed facts decay with age; rulings do not", async () => {
    const db = freshDb();
    const old = new Date(Date.now() - 240 * 86_400_000).toISOString();
    append(db, ev({ subject: "old observation", paths: ["a.ts"], confidence: "observed", validFrom: old }));
    append(db, ev({ subject: "old ruling", paths: ["a.ts"], confidence: "ruling", validFrom: old }));
    const facts = await retrieveForTask(db, { text: "", paths: ["a.ts"] });
    // A human decision does not become less true because it is old — it
    // becomes false only when superseded, which the query already filters.
    expect(facts[0]!.event.subject).toBe("old ruling");
    const obs = facts.find((f) => f.event.subject === "old observation")!;
    expect(obs.score).toBeLessThan(facts[0]!.score);
  });

  test("superseded facts never surface", async () => {
    const db = freshDb();
    const first = append(db, ev({ subject: "use callbacks everywhere", paths: ["a.ts"] })).event;
    append(db, ev({ subject: "use promises everywhere", paths: ["a.ts"], supersedes: first.id }));
    const facts = await retrieveForTask(db, { text: "callbacks", paths: ["a.ts"] });
    expect(facts.map((f) => f.event.subject)).not.toContain("use callbacks everywhere");
  });

  test("the task's own events are excluded", async () => {
    const db = freshDb();
    append(db, ev({ subject: "my own summary", paths: ["a.ts"], taskId: "t-me" }));
    append(db, ev({ subject: "someone else's rule", paths: ["a.ts"], taskId: "t-other" }));
    const facts = await retrieveForTask(db, { text: "", paths: ["a.ts"] }, undefined, { excludeTaskId: "t-me" });
    expect(facts.map((f) => f.event.taskId)).toEqual(["t-other"]);
  });

  test("one fact appears ONCE even when both seeds find it", async () => {
    // The de-duplication that motivated merging the two prompt sections.
    const db = freshDb();
    append(db, ev({ subject: "session expiry rule", paths: ["src/session.ts"] }));
    const facts = await retrieveForTask(db, { text: "session expiry rule", paths: ["src/session.ts"] });
    expect(facts.length).toBe(1);
  });

  test("respects the hard budget", async () => {
    const db = freshDb();
    for (let i = 0; i < 20; i++) append(db, ev({ subject: `rule ${i}`, body: `b${i}`, paths: ["a.ts"] }));
    expect((await retrieveForTask(db, { text: "", paths: ["a.ts"] }, undefined, { limit: 3 })).length).toBe(3);
  });

  test("reaches a caller's knowledge when given a code index", async () => {
    const root = mkdtempSync(join(tmpdir(), "at-retr-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/session.ts"), "export function createSession(u: string) { return u; }\n");
    writeFileSync(join(root, "src/api.ts"), `import { createSession } from "./session.ts";\ncreateSession("u");\n`);
    const index = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts", "src/api.ts"] });

    const db = freshDb();
    append(db, ev({ subject: "api layer must validate input", paths: ["src/api.ts"], confidence: "observed" }));

    const facts = await retrieveForTask(db, { text: "refactor session creation", paths: ["src/session.ts"] }, index);
    expect(facts.map((f) => f.event.subject)).toContain("api layer must validate input");
    expect(facts[0]!.hops).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("degrades to lexical-only when there are no paths", async () => {
    const db = freshDb();
    append(db, ev({ subject: "caching strategy for sessions", paths: [] }));
    const facts = await retrieveForTask(db, { text: "caching strategy", paths: [] });
    expect(facts.length).toBe(1);
    expect(facts[0]!.sources).toEqual(["lexical"]);
  });

  test("format says HOW each fact was reached", async () => {
    const db = freshDb();
    append(db, ev({ subject: "the rule", body: "the detail", paths: ["a.ts"] }));
    const out = formatRetrievedFacts(await retrieveForTask(db, { text: "", paths: ["a.ts"] }));
    expect(out).toContain("the rule");
    expect(out).toContain("governs");   // "why am I being told this"
    expect(formatRetrievedFacts([])).toBe("");
  });
});
