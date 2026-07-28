import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillFromContextDir } from "./backfill.ts";
import { KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES } from "./schema.ts";
import { count, list } from "./store.ts";

function freshDb() {
  const db = new Database(":memory:");
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) db.exec(s);
  return db;
}

function seedContext(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "at-backfill-"));
  const dir = join(root, ".agent-trail", "context");
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, "utf8");
  }
  return root;
}

describe("backfillFromContextDir()", () => {
  test("returns an empty report when the dir doesn't exist", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "at-empty-"));
    const rpt = backfillFromContextDir(db, root);
    expect(rpt.decisionsInserted).toBe(0);
    expect(rpt.notesInserted).toBe(0);
    expect(count(db)).toBe(0);
  });

  test("parses decisions.md into decision events with author + date", () => {
    const root = seedContext({
      "decisions.md": `# Decisions

## 2026-07-20 — Wire the model router
**Q:** Should we default to haiku or sonnet?

**A:** Default to haiku; escalate to sonnet after two failed verifies.

_— Nish_

## 2026-07-25 — Deploy targets
**Q:** Where should deploy targets live?

**A:** New table \`deploy_targets\`, one row per named target per board.

_— alice_
`,
    });
    const db = freshDb();
    const rpt = backfillFromContextDir(db, root);
    expect(rpt.decisionsInserted).toBe(2);
    const events = list(db, { type: "decision" });
    expect(events).toHaveLength(2);
    // Sorted by ULID (id), which is created_at order — first block first.
    expect(events[0]?.subject).toMatch(/Wire the model router/);
    expect(events[0]?.actorName).toBe("Nish");
    expect(events[0]?.validFrom.startsWith("2026-07-20")).toBe(true);
    expect(events[0]?.confidence).toBe("ruling");
    expect(events[1]?.actorName).toBe("alice");
  });

  test("is idempotent — running twice produces the same row set", () => {
    const root = seedContext({
      "decisions.md": `## 2026-07-20 — X\n**Q:** why\n\n**A:** because\n\n_— Nish_\n`,
    });
    const db = freshDb();
    const first = backfillFromContextDir(db, root);
    const second = backfillFromContextDir(db, root);
    expect(first.decisionsInserted).toBe(1);
    expect(second.decisionsInserted).toBe(0);
    expect(second.decisionsSkipped).toBe(1);
    expect(count(db)).toBe(1);
  });

  test("notes.md bullets become convention events", () => {
    const root = seedContext({
      "notes.md": `# Notes\n\n- (2026-07-01, Nish) prefer conventional commits\n- (2026-07-02, alice) never disable the TDD gate\n`,
    });
    const db = freshDb();
    const rpt = backfillFromContextDir(db, root);
    expect(rpt.notesInserted).toBe(2);
    const events = list(db, { type: "convention" });
    expect(events.map((e) => e.actorName)).toEqual(["Nish", "alice"]);
  });

  test("plain bullets without metadata still get imported", () => {
    const root = seedContext({
      "architecture.md": `# Arch rules\n\n- L0 constitution goes first\n- Do not use CRDT libraries\n`,
    });
    const db = freshDb();
    const rpt = backfillFromContextDir(db, root);
    expect(rpt.notesInserted).toBe(2);
    const events = list(db, { type: "convention" });
    expect(events.map((e) => e.subject).sort()).toEqual([
      "Do not use CRDT libraries",
      "L0 constitution goes first",
    ]);
  });
});
