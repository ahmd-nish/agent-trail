import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { append } from "./store.ts";
import { foldConstitution } from "./fold.ts";
import { KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES } from "./schema.ts";
import type { NewKnowledgeEvent } from "./types.ts";

function db(): Database {
  const d = new Database(":memory:");
  d.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) d.exec(s);
  return d;
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

describe("foldConstitution()", () => {
  test("empty log produces empty markdown", () => {
    const { markdown, sections, truncated } = foldConstitution(db());
    expect(markdown).toBe("");
    expect(sections).toHaveLength(0);
    expect(truncated).toBe(false);
  });

  test("groups by type in the fixed section order", () => {
    const d = db();
    append(d, ev({ type: "gotcha",     subject: "token expires after 1h" }));
    append(d, ev({ type: "decision",   subject: "use SQLite locally" }));
    append(d, ev({ type: "convention", subject: "conventional commits" }));

    const { markdown, sections } = foldConstitution(d);
    expect(sections.map((s) => s.type)).toEqual(["decision", "convention", "gotcha"]);
    expect(markdown.indexOf("Decisions")).toBeLessThan(markdown.indexOf("Conventions"));
    expect(markdown.indexOf("Conventions")).toBeLessThan(markdown.indexOf("Gotchas"));
  });

  test("recency wins — the most recent decision appears first inside its section (§3.1 fix)", () => {
    const d = db();
    append(d, ev({ subject: "OLDEST", body: "" }));
    append(d, ev({ subject: "MIDDLE", body: "" }));
    append(d, ev({ subject: "NEWEST", body: "" }));

    const { markdown } = foldConstitution(d);
    expect(markdown.indexOf("NEWEST")).toBeLessThan(markdown.indexOf("MIDDLE"));
    expect(markdown.indexOf("MIDDLE")).toBeLessThan(markdown.indexOf("OLDEST"));
  });

  test("superseded rulings never appear in the fold (§3.2 fix)", () => {
    const d = db();
    const old = append(d, ev({ subject: "Use Postgres" }));
    append(d, ev({ subject: "Actually SQLite", supersedes: old.event.id }));

    const { markdown, sections } = foldConstitution(d);
    expect(markdown).toContain("Actually SQLite");
    expect(markdown).not.toContain("Use Postgres");
    expect(sections[0]?.entries).toHaveLength(1);
  });

  test("char cap truncates without corrupting section boundaries", () => {
    const d = db();
    for (let i = 0; i < 40; i++) {
      append(d, ev({ subject: `ruling-${i}`, body: "x".repeat(200) }));
    }
    const { markdown, totalChars, truncated } = foldConstitution(d, { charCap: 2000 });
    expect(truncated).toBe(true);
    expect(totalChars).toBeLessThanOrEqual(2000);
    // The header for the section we started should still be present.
    expect(markdown).toContain("Decisions");
  });

  test("scope filter — module: and task: are excluded by default", () => {
    const d = db();
    append(d, ev({ scope: "project", subject: "project rule" }));
    append(d, ev({ scope: "module:packages/core", subject: "module rule" }));
    append(d, ev({ scope: "task:t-abc", subject: "task rule" }));

    const { markdown } = foldConstitution(d);
    expect(markdown).toContain("project rule");
    expect(markdown).not.toContain("module rule");
    expect(markdown).not.toContain("task rule");
  });
});
