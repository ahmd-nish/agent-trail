import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { append } from "./store.ts";
import { search } from "./search.ts";
import {
  KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_FTS, KNOWLEDGE_EVENTS_FTS_TRIGGERS,
  KNOWLEDGE_EVENTS_INDEXES,
} from "./schema.ts";
import type { NewKnowledgeEvent } from "./types.ts";

function freshDb() {
  const db = new Database(":memory:");
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) db.exec(s);
  db.exec(KNOWLEDGE_EVENTS_FTS);
  for (const s of KNOWLEDGE_EVENTS_FTS_TRIGGERS) db.exec(s);
  return db;
}

function ev(o: Partial<NewKnowledgeEvent> = {}): NewKnowledgeEvent {
  return {
    workspaceId: "local", projectId: "test",
    actorKind: "human", actorId: "n@x", actorName: "Nish",
    taskId: null, executionId: null,
    type: "convention", scope: "project",
    subject: "sub", body: "body",
    paths: [], confidence: "ruling", supersedes: null,
    ...o,
  };
}

describe("search() — FTS5 ranked retrieval", () => {
  test("returns [] on empty query", () => {
    const db = freshDb();
    append(db, ev({ subject: "anything" }));
    expect(search(db, "")).toEqual([]);
    expect(search(db, "   ")).toEqual([]);
  });

  test("finds by subject match", () => {
    const db = freshDb();
    append(db, ev({ subject: "authentication middleware retry policy" }));
    append(db, ev({ subject: "unrelated topic about caching" }));
    const hits = search(db, "authentication");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.event.subject).toMatch(/authentication/);
  });

  test("finds by body match", () => {
    const db = freshDb();
    append(db, ev({ subject: "sub A", body: "we serialize using msgpack in the wire protocol" }));
    append(db, ev({ subject: "sub B", body: "conventional commits enforced by hook" }));
    const hits = search(db, "msgpack");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.event.subject).toBe("sub A");
  });

  test("ranks confidence tiers — ruling above inferred at same relevance", () => {
    const db = freshDb();
    // The two events must be semantically distinct or the store will dedupe them
    // (content_hash is derived from type + scope + subject + body).
    append(db, ev({ subject: "auth token expiry — inferred", body: "auth token expires after an hour", confidence: "inferred", actorId: "a@x" }));
    append(db, ev({ subject: "auth token expiry — ruling",   body: "auth token expires after an hour", confidence: "ruling",   actorId: "b@x" }));
    const hits = search(db, "auth token");
    // Both match. The `ruling` should score higher than the `inferred`.
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const rulingHit = hits.find((h) => h.event.confidence === "ruling");
    const inferredHit = hits.find((h) => h.event.confidence === "inferred");
    expect(rulingHit).toBeDefined();
    expect(inferredHit).toBeDefined();
    if (rulingHit && inferredHit) {
      expect(rulingHit.score).toBeGreaterThan(inferredHit.score);
    }
  });

  test("filters by type", () => {
    const db = freshDb();
    append(db, ev({ type: "decision",   subject: "keyword decision" }));
    append(db, ev({ type: "convention", subject: "keyword convention" }));
    const hits = search(db, "keyword", { type: "decision" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.event.type).toBe("decision");
  });

  test("excludes superseded events", () => {
    const db = freshDb();
    const older = append(db, ev({ subject: "old ruling: use Postgres" }));
    append(db, ev({ subject: "new ruling: use SQLite instead", supersedes: older.event.id }));
    const hits = search(db, "ruling");
    // The old one is superseded → not in results.
    expect(hits.every((h) => !h.event.subject.startsWith("old ruling"))).toBe(true);
  });

  test("tolerates punctuated user queries (`how do we handle auth?`)", () => {
    const db = freshDb();
    append(db, ev({ subject: "auth token handling" }));
    // The `?` and `,` shouldn't blow up FTS5. sanitizer quotes each token.
    const hits = search(db, "how do we handle auth?");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.event.subject).toMatch(/auth/);
  });
});
