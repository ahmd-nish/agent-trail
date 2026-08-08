import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectModuleBriefs, projectObsidianVault, projectProjectMap } from "./projections.ts";
import { KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES } from "./schema.ts";
import { append } from "./store.ts";
import type { NewKnowledgeEvent } from "./types.ts";

function freshDb(): Database {
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
    subject: "a fact", body: "detail", paths: [],
    confidence: "ruling", supersedes: null,
    ...o,
  };
}

describe("projectModuleBriefs (§4.2)", () => {
  test("groups facts by their immediate parent directory", () => {
    const db = freshDb();
    append(db, ev({ subject: "auth uses sha256", paths: ["src/auth/session.ts"] }));
    append(db, ev({ subject: "auth tokens expire in 1h", paths: ["src/auth/token.ts"] }));
    append(db, ev({ subject: "ui uses tailwind", paths: ["src/ui/button.tsx"] }));

    const briefs = projectModuleBriefs(db, { minFacts: 2 });
    expect(briefs.map((b) => b.module)).toEqual(["src/auth"]);   // src/ui has only 1
    expect(briefs[0]!.facts.length).toBe(2);
    expect(briefs[0]!.markdown).toContain("# src/auth");
    expect(briefs[0]!.markdown).toContain("sha256");
  });

  test("does not file facts under a too-coarse ancestor", () => {
    // Attributing to every ancestor would put both facts under `src`, which is
    // not a brief about anything.
    const db = freshDb();
    append(db, ev({ subject: "a", paths: ["src/auth/one.ts"] }));
    append(db, ev({ subject: "b", paths: ["src/auth/two.ts"] }));
    const briefs = projectModuleBriefs(db, { minFacts: 1 });
    expect(briefs.map((b) => b.module)).not.toContain("src");
  });

  test("separates rulings from observations", () => {
    const db = freshDb();
    append(db, ev({ subject: "the ruling", paths: ["m/a.ts"], confidence: "ruling" }));
    append(db, ev({ subject: "the observation", paths: ["m/b.ts"], confidence: "observed", type: "gotcha" }));
    const md = projectModuleBriefs(db, { minFacts: 2 })[0]!.markdown;
    expect(md.indexOf("## Rulings")).toBeLessThan(md.indexOf("## Observed"));
  });

  test("honours module: scope even without paths", () => {
    const db = freshDb();
    append(db, ev({ subject: "one", scope: "module:packages/core" }));
    append(db, ev({ subject: "two", scope: "module:packages/core" }));
    expect(projectModuleBriefs(db, { minFacts: 2 })[0]!.module).toBe("packages/core");
  });

  test("superseded facts are excluded — a fold cannot drift from history", () => {
    const db = freshDb();
    const first = append(db, ev({ subject: "old rule", paths: ["m/a.ts"] })).event;
    append(db, ev({ subject: "new rule", paths: ["m/a.ts"], supersedes: first.id }));
    append(db, ev({ subject: "other", paths: ["m/b.ts"] }));
    const md = projectModuleBriefs(db, { minFacts: 1 })[0]!.markdown;
    expect(md).toContain("new rule");
    expect(md).not.toContain("old rule");
  });

  test("empty log yields no briefs", () => {
    expect(projectModuleBriefs(freshDb())).toEqual([]);
  });
});

describe("projectProjectMap (§4.2)", () => {
  function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "at-projmap-"));
    spawnSync("git", ["init", "-q"], { cwd: root });
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), content, "utf-8");
    }
    spawnSync("git", ["add", "-A"], { cwd: root });
    return root;
  }

  test("detects stack from manifests and dependencies", () => {
    const root = repo({
      "package.json": JSON.stringify({ dependencies: { hono: "^4", react: "^18" } }),
      "tsconfig.json": "{}",
      "bunfig.toml": "",
      "src/index.ts": "export const x = 1;",
    });
    const map = projectProjectMap(root);
    expect(map.stack).toContain("Bun");
    expect(map.stack).toContain("TypeScript");
    expect(map.stack).toContain("Hono");
    expect(map.stack).toContain("React");
    expect(map.markdown).toContain("# PROJECT_MAP");
    rmSync(root, { recursive: true, force: true });
  });

  test("lists entrypoints and directory sizes", () => {
    const root = repo({
      "package.json": "{}",
      "src/index.ts": "x", "src/util.ts": "x", "src/other.ts": "x",
      "web/app.tsx": "x",
    });
    const map = projectProjectMap(root);
    expect(map.entrypoints).toContain("src/index.ts");
    expect(map.entrypoints).toContain("web/app.tsx");
    expect(map.topDirs[0]!.dir).toBe("src");
    rmSync(root, { recursive: true, force: true });
  });

  test("a non-git directory degrades to an empty map rather than throwing", () => {
    const plain = mkdtempSync(join(tmpdir(), "at-nogit-"));
    const map = projectProjectMap(plain);
    expect(map.topDirs).toEqual([]);
    expect(map.markdown).toContain("PROJECT_MAP");
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("projectObsidianVault (export projection, not a store)", () => {
  test("one note per active event, with frontmatter and wikilinks", () => {
    const db = freshDb();
    append(db, ev({ subject: "sessions use sha256", body: "never raw", paths: ["src/auth/session.ts"] }));
    const notes = projectObsidianVault(db);
    const note = notes.find((n) => n.path.startsWith("events/"))!;
    expect(note.markdown).toContain("type: decision");
    expect(note.markdown).toContain("confidence: ruling");
    expect(note.markdown).toContain("actor: Nish");
    expect(note.markdown).toContain("# sessions use sha256");
    expect(note.markdown).toContain("[[src/auth]]");
  });

  test("emits a module index note linking its events", () => {
    const db = freshDb();
    append(db, ev({ subject: "one", paths: ["m/a.ts"] }));
    append(db, ev({ subject: "two", paths: ["m/b.ts"] }));
    const idx = projectObsidianVault(db).find((n) => n.path === "modules/m.md")!;
    expect(idx.markdown).toContain("# m");
    expect((idx.markdown.match(/\[\[/g) ?? []).length).toBe(2);
  });

  test("same-titled events do not collide on disk", () => {
    const db = freshDb();
    append(db, ev({ subject: "same title", body: "first" }));
    append(db, ev({ subject: "same title", body: "second" }));
    const paths = projectObsidianVault(db).map((n) => n.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("superseded events are not exported", () => {
    const db = freshDb();
    const first = append(db, ev({ subject: "old", paths: ["m/a.ts"] })).event;
    append(db, ev({ subject: "new", paths: ["m/a.ts"], supersedes: first.id }));
    const md = projectObsidianVault(db).map((n) => n.markdown).join("\n");
    expect(md).toContain("# new");
    expect(md).not.toContain("# old");
  });
});
