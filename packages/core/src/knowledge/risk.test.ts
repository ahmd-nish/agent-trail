import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { append } from "./store.ts";
import { buildRiskIndex, formatRiskWarnings } from "./risk.ts";
import { KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES } from "./schema.ts";
import type { NewKnowledgeEvent } from "./types.ts";

function freshDb() {
  const db = new Database(":memory:");
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) db.exec(s);
  return db;
}

function ev(o: Partial<NewKnowledgeEvent> = {}): NewKnowledgeEvent {
  return {
    workspaceId: "local", projectId: "test",
    actorKind: "agent", actorId: "claude", actorName: "Claude",
    taskId: null, executionId: null,
    type: "failed_attempt", scope: "project",
    subject: "sub", body: "body",
    paths: [], confidence: "observed", supersedes: null,
    ...o,
  };
}

describe("buildRiskIndex()", () => {
  test("empty path list returns empty index", () => {
    const db = freshDb();
    append(db, ev({ paths: ["packages/core/auth.ts"] }));
    const idx = buildRiskIndex(db, []);
    expect(idx.totalHits).toBe(0);
    expect(idx.perPath).toEqual({});
  });

  test("counts failed_attempt events whose paths match the query", () => {
    const db = freshDb();
    append(db, ev({ paths: ["packages/core/auth.ts"], subject: "iter 1 fail" }));
    append(db, ev({ paths: ["packages/core/auth.ts"], subject: "iter 2 fail" }));
    append(db, ev({ paths: ["packages/core/other.ts"], subject: "elsewhere" }));
    const idx = buildRiskIndex(db, ["packages/core/auth.ts"]);
    expect(idx.perPath["packages/core/auth.ts"]?.count).toBe(2);
    expect(idx.perPath["packages/core/other.ts"]).toBeUndefined();
  });

  test("counts gotcha events too — thrash writes them", () => {
    const db = freshDb();
    append(db, ev({ type: "gotcha", paths: ["packages/core/auth.ts"], subject: "thrash: same error twice" }));
    const idx = buildRiskIndex(db, ["packages/core/auth.ts"]);
    expect(idx.perPath["packages/core/auth.ts"]?.count).toBe(1);
    expect(idx.perPath["packages/core/auth.ts"]?.events[0]?.type).toBe("gotcha");
  });

  test("prefix path match — asking about a directory catches events on its files", () => {
    const db = freshDb();
    append(db, ev({ paths: ["packages/core/auth/session.ts"], subject: "session fail" }));
    append(db, ev({ paths: ["packages/core/auth/token.ts"], subject: "token fail" }));
    const idx = buildRiskIndex(db, ["packages/core/auth"]);
    expect(idx.perPath["packages/core/auth"]?.count).toBe(2);
  });

  test("scope=module:<path> matches even when paths[] is empty", () => {
    const db = freshDb();
    // A gotcha scoped to a directory but with no explicit paths — should still hit.
    append(db, ev({ type: "gotcha", scope: "module:packages/server", paths: [], subject: "server-wide gotcha" }));
    const idx = buildRiskIndex(db, ["packages/server/routes/api.ts"]);
    expect(idx.perPath["packages/server/routes/api.ts"]?.count).toBe(1);
  });

  test("excludes superseded events — no ghost warnings", () => {
    const db = freshDb();
    const older = append(db, ev({ paths: ["auth.ts"], subject: "old approach failed" }));
    append(db, ev({ paths: ["auth.ts"], subject: "resolved via different approach", type: "fix", supersedes: older.event.id }));
    const idx = buildRiskIndex(db, ["auth.ts"]);
    // The failed_attempt was superseded by the fix, and the fix isn't a risk event.
    expect(idx.totalHits).toBe(0);
  });

  test("caps events per path", () => {
    const db = freshDb();
    for (let i = 0; i < 12; i++) {
      append(db, ev({ paths: ["hot.ts"], subject: `fail ${i}` }));
    }
    const idx = buildRiskIndex(db, ["hot.ts"], { maxEventsPerPath: 3 });
    expect(idx.perPath["hot.ts"]?.count).toBe(12); // count is accurate
    expect(idx.perPath["hot.ts"]?.events).toHaveLength(3); // but only 3 events kept
  });

  test("`since` filter excludes ancient events", () => {
    const db = freshDb();
    // A synthetic old ULID + valid_from will be filtered by valid_from filter.
    const oldIso = "2020-01-01T00:00:00.000Z";
    append(db, ev({ paths: ["a.ts"], subject: "ancient", validFrom: oldIso }));
    append(db, ev({ paths: ["a.ts"], subject: "recent" }));
    const idx = buildRiskIndex(db, ["a.ts"], { since: "2024-01-01T00:00:00.000Z" });
    expect(idx.perPath["a.ts"]?.count).toBe(1);
    expect(idx.perPath["a.ts"]?.events[0]?.subject).toBe("recent");
  });
});

describe("formatRiskWarnings()", () => {
  test("empty index → empty string (safe to concat)", () => {
    expect(formatRiskWarnings({ perPath: {}, totalHits: 0 })).toBe("");
  });

  test("renders a human-readable block", () => {
    const db = freshDb();
    append(db, ev({
      paths: ["auth.ts"], actorName: "sarah",
      subject: "iter 2 · auth · verify_tests failed (exit 1)",
      validFrom: "2026-07-25T00:00:00.000Z",
    }));
    const idx = buildRiskIndex(db, ["auth.ts"]);
    const out = formatRiskWarnings(idx);
    expect(out).toContain("risk index");
    expect(out).toContain("auth.ts");
    expect(out).toContain("2026-07-25");
    expect(out).toContain("sarah");
    expect(out).toContain("Consider a different approach");
  });
});
