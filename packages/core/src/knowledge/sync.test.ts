import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  KNOWLEDGE_EDGES_DDL, KNOWLEDGE_EDGES_INDEXES,
  KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES,
} from "./schema.ts";
import { append } from "./store.ts";
import { applyIncoming, envelopeCursor, pendingPush, syncOnce } from "./sync.ts";
import type { NewKnowledgeEvent } from "./types.ts";

function db2(): Database {
  const db = new Database(":memory:");
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) db.exec(s);
  db.exec(KNOWLEDGE_EDGES_DDL);
  for (const s of KNOWLEDGE_EDGES_INDEXES) db.exec(s);
  return db;
}

function ev(o: Partial<NewKnowledgeEvent> = {}): NewKnowledgeEvent {
  return {
    workspaceId: "w", projectId: "p",
    actorKind: "human", actorId: "a@x", actorName: "A",
    taskId: null, executionId: null,
    type: "decision", scope: "project",
    subject: "s", body: "b", paths: [], confidence: "ruling", supersedes: null,
    ...o,
  };
}

describe("§4.6 sync internals", () => {
  test("pendingPush is bounded by the batch limit", () => {
    const db = db2();
    for (let i = 0; i < 30; i++) append(db, ev({ subject: `s${i}`, body: `b${i}` }));
    const { events } = pendingPush(db, { workspaceId: "w", projectId: "p", limit: 10 });
    expect(events.length).toBe(10);
    // Ordered by ULID so the cursor advances monotonically.
    expect([...events].map((e) => e.id).sort()).toEqual(events.map((e) => e.id));
  });

  test("pendingPush respects the cursor", () => {
    const db = db2();
    for (let i = 0; i < 5; i++) append(db, ev({ subject: `s${i}`, body: `b${i}` }));
    const all = pendingPush(db, { workspaceId: "w", projectId: "p" }).events;
    const after = pendingPush(db, { workspaceId: "w", projectId: "p", sinceEvent: all[1]!.id }).events;
    expect(after.length).toBe(3);
    expect(after.every((e) => e.id > all[1]!.id)).toBe(true);
  });

  test("superseded events still replicate — supersession is state too", () => {
    const db = db2();
    const first = append(db, ev({ subject: "old" })).event;
    append(db, ev({ subject: "new", supersedes: first.id }));
    const ids = pendingPush(db, { workspaceId: "w", projectId: "p" }).events.map((e) => e.id);
    expect(ids).toContain(first.id);
  });

  test("another project's rows are never in the push set", () => {
    const db = db2();
    append(db, ev({ subject: "mine", projectId: "p" }));
    append(db, ev({ subject: "theirs", projectId: "other" }));
    const subs = pendingPush(db, { workspaceId: "w", projectId: "p" }).events.map((e) => e.subject);
    expect(subs).toEqual(["mine"]);
  });

  test("applyIncoming is idempotent and preserves ids", () => {
    const src = db2();
    const dst = db2();
    const { event } = append(src, ev({ subject: "replicated" }));
    const envelope = pendingPush(src, { workspaceId: "w", projectId: "p" });

    const first = applyIncoming(dst, envelope);
    const second = applyIncoming(dst, envelope);
    expect(first.events).toBe(1);
    expect(second.events).toBe(0);           // grow-only set
    expect(pendingPush(dst, { workspaceId: "w", projectId: "p" }).events[0]!.id).toBe(event.id);
  });

  test("applyIncoming skips malformed rows without losing the good ones", () => {
    const dst = db2();
    const res = applyIncoming(dst, {
      events: [null, { id: "x" }, { ...ev({ subject: "good" }), id: "01JGOOD0000000000000000001", validFrom: new Date().toISOString() }],
    });
    expect(res.events).toBe(1);
    expect(res.rejected).toBe(2);
  });

  test("envelopeCursor is the max id across both collections", () => {
    expect(envelopeCursor([{ id: "b" }], [{ id: "c" }])).toBe("c");
    expect(envelopeCursor([], [])).toBeNull();
  });

  test("localOnly short-circuits before any network call", async () => {
    const db = db2();
    append(db, ev({ subject: "secret" }));
    let called = false;
    const res = await syncOnce(db, {
      remote: "http://example.invalid", workspaceId: "w", projectId: "p",
      localOnly: true,
      fetchImpl: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(res.skipped).toBe(true);
  });

  test("a push failure leaves the cursor untouched so nothing is lost", async () => {
    const db = db2();
    append(db, ev({ subject: "must survive" }));
    const res = await syncOnce(db, {
      remote: "http://example.invalid", workspaceId: "w", projectId: "p",
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(res.skipped).toBe(true);
    // Still pending — a failed push must never look like a successful one.
    expect(pendingPush(db, { workspaceId: "w", projectId: "p" }).events.length).toBe(1);
  });

  test("hasMore signals a backlog rather than looping internally", async () => {
    const db = db2();
    for (let i = 0; i < 12; i++) append(db, ev({ subject: `s${i}`, body: `b${i}` }));
    const res = await syncOnce(db, {
      remote: "http://relay.test", workspaceId: "w", projectId: "p", batchLimit: 10,
      fetchImpl: (async (url: string) =>
        String(url).includes("?")
          ? new Response(JSON.stringify({ events: [], edges: [], cursor: null }))
          : new Response(JSON.stringify({ inserted: { events: 10, edges: 0 }, rejected: 0 }))
      ) as unknown as typeof fetch,
    });
    expect(res.hasMore).toBe(true);
  });
});
