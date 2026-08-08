import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES } from "./schema.ts";
import { append, count, getById, hashEvent, list } from "./store.ts";
import { BODY_CHAR_CAP } from "./types.ts";
import type { NewKnowledgeEvent } from "./types.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const sql of KNOWLEDGE_EVENTS_INDEXES) db.exec(sql);
  return db;
}

function baseEvent(overrides: Partial<NewKnowledgeEvent> = {}): NewKnowledgeEvent {
  return {
    workspaceId: "local",
    projectId: "test-repo",
    actorKind: "human",
    actorId: "nish@example.com",
    actorName: "Nish",
    taskId: null,
    executionId: null,
    type: "decision",
    scope: "project",
    subject: "Use SQLite for local storage",
    body: "Postgres is only used in the relay. Local mirror is bun:sqlite.",
    paths: [],
    confidence: "ruling",
    supersedes: null,
    ...overrides,
  };
}

describe("append()", () => {
  test("inserts a new event with a ULID id and timestamps", () => {
    const db = freshDb();
    const { event, inserted } = append(db, baseEvent());
    expect(inserted).toBe(true);
    expect(event.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(event.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event.validFrom).toBe(event.createdAt);
    expect(event.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.supersededBy).toBeNull();
  });

  test("is idempotent — a second append with identical semantic payload keeps the first row", () => {
    const db = freshDb();
    const first = append(db, baseEvent());
    const second = append(db, baseEvent());
    expect(second.inserted).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(count(db)).toBe(1);
  });

  test("redacts secrets in body before persisting", () => {
    const db = freshDb();
    const { event } = append(db, baseEvent({
      body: "the key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef in prod",
    }));
    expect(event.body).not.toContain("sk-ant-");
    expect(event.body).toContain("[REDACTED]");

    // Verify the persisted row too — belt AND braces.
    const row = getById(db, event.id);
    expect(row?.body).not.toContain("sk-ant-");
  });

  test("clamps a prose body to the 1200-char prose cap", () => {
    const db = freshDb();
    const big = "x".repeat(5000);
    const { event } = append(db, baseEvent({ body: big }));
    expect(event.body.length).toBe(BODY_CHAR_CAP);
    expect(BODY_CHAR_CAP).toBe(1200);
  });

  test("a capability contract on artifact_summary earns the 4000-char cap", () => {
    const db = freshDb();
    const contract = JSON.stringify({
      type: "capability_contract",
      taskId: "t-1",
      baseSha: null,
      provides: { modules: ["a.ts"], exports: ["x".repeat(3000)], routes: [], tables: [], env: [], events: [] },
      invariants: [],
      deliberatelyNotDone: [],
      entrypoints: [],
    });
    expect(contract.length).toBeGreaterThan(BODY_CHAR_CAP);
    const { event } = append(db, baseEvent({ type: "artifact_summary", body: contract }));
    expect(event.body).toBe(contract);
    expect(JSON.parse(event.body).provides.modules).toEqual(["a.ts"]);
  });

  test("prose on artifact_summary is still held to the prose cap", () => {
    const db = freshDb();
    const { event } = append(db, baseEvent({ type: "artifact_summary", body: "y".repeat(5000) }));
    expect(event.body.length).toBe(BODY_CHAR_CAP);
  });

  test("a non-contract event cannot claim the contract cap by looking like JSON", () => {
    const db = freshDb();
    // Same shape, wrong event type — the larger budget is earned by artifact
    // summaries only, so a `gotcha` carrying contract-ish JSON gets clamped.
    const body = JSON.stringify({ type: "capability_contract", provides: { pad: "z".repeat(3000) } });
    const { event } = append(db, baseEvent({ type: "gotcha", body }));
    expect(event.body.length).toBe(BODY_CHAR_CAP);
  });

  test("supersession — marks the older event as superseded_by the newer", () => {
    const db = freshDb();
    const old = append(db, baseEvent({ subject: "Use Postgres for storage" }));
    const fresh = append(db, baseEvent({
      subject: "Use SQLite locally + Postgres for the relay",
      supersedes: old.event.id,
    }));

    const oldRow = getById(db, old.event.id);
    expect(oldRow?.supersededBy).toBe(fresh.event.id);

    const active = list(db, { type: "decision" });
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(fresh.event.id);

    const all = list(db, { type: "decision", activeOnly: false });
    expect(all).toHaveLength(2);
  });

  test("scope filters — module: and task: prefixes round-trip", () => {
    const db = freshDb();
    append(db, baseEvent({ scope: "module:packages/core", subject: "core rule" }));
    append(db, baseEvent({ scope: "task:t-abc",           subject: "task rule" }));
    append(db, baseEvent({ scope: "project",              subject: "project rule" }));

    expect(list(db, { scope: "module:packages/core" })).toHaveLength(1);
    expect(list(db, { scope: "task:t-abc" })).toHaveLength(1);
    expect(list(db, { scope: "project" })).toHaveLength(1);
  });

  test("cursor tail — sinceId returns strictly-later events", () => {
    const db = freshDb();
    const a = append(db, baseEvent({ subject: "A" })).event;
    const b = append(db, baseEvent({ subject: "B" })).event;
    const c = append(db, baseEvent({ subject: "C" })).event;

    const tail = list(db, { sinceId: a.id });
    expect(tail.map((e) => e.id)).toEqual([b.id, c.id]);
  });
});

describe("hashEvent()", () => {
  test("is stable across whitespace-only differences in inputs", () => {
    const h1 = hashEvent({ type: "decision", scope: "project", subject: " x ", body: " y ", supersedes: null });
    const h2 = hashEvent({ type: "decision", scope: "project", subject: "x",   body: "y",   supersedes: null });
    expect(h1).toBe(h2);
  });

  test("changes when supersedes changes — allows an amend to coexist with the original", () => {
    const h1 = hashEvent({ type: "decision", scope: "project", subject: "x", body: "y", supersedes: null });
    const h2 = hashEvent({ type: "decision", scope: "project", subject: "x", body: "y", supersedes: "01ABC" });
    expect(h1).not.toBe(h2);
  });
});
