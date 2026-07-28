import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { append } from "./store.ts";
import {
  exportEventsToJsonl, importEventsFromJsonl,
  projectAgentsMd, projectConstitutionMd,
} from "./export.ts";
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
    actorKind: "human", actorId: "n@x", actorName: "Nish",
    taskId: null, executionId: null,
    type: "decision", scope: "project",
    subject: "sub", body: "body",
    paths: [], confidence: "ruling", supersedes: null,
    ...o,
  };
}

describe("JSONL round trip — export then import is idempotent", () => {
  test("empty log exports as empty string", () => {
    expect(exportEventsToJsonl(freshDb())).toBe("");
  });

  test("N events export → N JSONL lines", () => {
    const db = freshDb();
    append(db, ev({ subject: "one" }));
    append(db, ev({ subject: "two" }));
    append(db, ev({ subject: "three" }));
    const jsonl = exportEventsToJsonl(db);
    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.workspaceId).toBe("local");
      expect(parsed.subject).toBeString();
    }
  });

  test("importing our own export into a fresh DB reproduces the same semantic state", () => {
    const src = freshDb();
    append(src, ev({ subject: "A" }));
    append(src, ev({ subject: "B" }));
    const jsonl = exportEventsToJsonl(src);

    const dest = freshDb();
    const rpt = importEventsFromJsonl(dest, jsonl);
    expect(rpt.inserted).toBe(2);
    expect(rpt.skipped).toBe(0);

    // Compare on the fields that must survive round-trip. createdAt is
    // re-stamped by append() on the destination, which is fine — the
    // event id (ULID) and content_hash are stable.
    const srcRows = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    const destJsonl = exportEventsToJsonl(dest);
    const destRows = destJsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(destRows.map((r) => r.id).sort()).toEqual(srcRows.map((r) => r.id).sort());
    expect(destRows.map((r) => r.contentHash).sort()).toEqual(srcRows.map((r) => r.contentHash).sort());
    expect(destRows.map((r) => r.subject).sort()).toEqual(srcRows.map((r) => r.subject).sort());
  });

  test("import is idempotent — a second pass over the same JSONL inserts nothing", () => {
    const db = freshDb();
    append(db, ev({ subject: "A" }));
    const jsonl = exportEventsToJsonl(db);
    const first = importEventsFromJsonl(db, jsonl);
    const second = importEventsFromJsonl(db, jsonl);
    expect(first.inserted).toBe(0); // the event is already there
    expect(first.skipped).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
  });

  test("malformed lines are skipped, not fatal", () => {
    const db = freshDb();
    const jsonl = [
      JSON.stringify({}), // missing required fields
      "not json at all",
      "",
    ].join("\n");
    const rpt = importEventsFromJsonl(db, jsonl);
    expect(rpt.skipped).toBeGreaterThanOrEqual(1);
  });

  test("supersession is preserved across export → import", () => {
    const src = freshDb();
    const older = append(src, ev({ subject: "old" }));
    append(src, ev({ subject: "new", supersedes: older.event.id }));
    // export with the superseded row included so the import can rebuild the chain
    const jsonl = exportEventsToJsonl(src, { includeSuperseded: true });
    const dest = freshDb();
    importEventsFromJsonl(dest, jsonl);
    // Active set on the destination should be just the new one.
    const active = JSON.parse(exportEventsToJsonl(dest).trim().split("\n").pop() as string);
    expect(active.subject).toBe("new");
  });
});

describe("projectAgentsMd()", () => {
  test("empty log produces a minimal file with just the header", () => {
    const md = projectAgentsMd(freshDb());
    expect(md).toContain("# AGENTS.md");
    expect(md).not.toContain("## Conventions");
  });

  test("groups by type and shows actor + date", () => {
    const db = freshDb();
    append(db, ev({ type: "convention", subject: "prefer conventional commits" }));
    append(db, ev({ type: "gotcha",     subject: "auth token expires after 1h" }));
    append(db, ev({ type: "decision",   subject: "use SQLite locally", actorName: "alice" }));
    const md = projectAgentsMd(db);
    expect(md).toContain("## Conventions");
    expect(md).toContain("## Decisions");
    expect(md).toContain("## Gotchas");
    expect(md).toContain("alice");
    expect(md).toContain("SQLite");
  });
});

describe("projectConstitutionMd()", () => {
  test("delegates to foldConstitution", () => {
    const db = freshDb();
    append(db, ev({ subject: "one true decision" }));
    const md = projectConstitutionMd(db);
    expect(md).toContain("Decisions");
    expect(md).toContain("one true decision");
  });
});
