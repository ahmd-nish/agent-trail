import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serializeState,
  deserializeAndUpsert,
  writeStateFile,
  readStateFile,
  exportToFile,
  hydrateFromFile,
  startAutoSync,
  statePath,
} from "./sync.ts";

const BOARD_INSERT = `INSERT INTO boards (id, name, prd_source, default_assignee, default_review_kind, permission_mode, implementation_dir, execution_timeout_ms, execution_cost_cap_usd, execution_token_cap, auto_commit, auto_pr, commit_style, created_at, updated_at)
                      VALUES (?, ?, ?, 'claude-code', 'none', 'acceptEdits', ?, 1200000, 0, 0, 0, 0, 'conventional', ?, ?)`;
const TASK_INSERT  = `INSERT INTO tasks (id, board_id, title, description, status, priority, assignee, tdd_enabled, tdd_phase, mcps, skills, subagents, depends_on, parallel_group, review_kind, external_dependencies, test_cases, created_at, updated_at, success_criteria, guardrails)
                      VALUES (?, ?, ?, ?, ?, 'medium', 'claude-code', ?, ?, '[]', '[]', '[]', ?, NULL, 'none', '[]', '[]', ?, ?, '[]', '[]')`;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prd_source TEXT,
      webhook_url TEXT,
      default_model TEXT,
      default_assignee TEXT NOT NULL DEFAULT 'claude-code',
      default_review_kind TEXT NOT NULL DEFAULT 'none',
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      implementation_dir TEXT,
      dev_command TEXT,
      dev_port INTEGER,
      execution_timeout_ms INTEGER NOT NULL DEFAULT 1200000,
      execution_cost_cap_usd REAL NOT NULL DEFAULT 0,
      execution_token_cap INTEGER NOT NULL DEFAULT 0,
      auto_commit INTEGER NOT NULL DEFAULT 0,
      auto_pr INTEGER NOT NULL DEFAULT 0,
      commit_style TEXT NOT NULL DEFAULT 'conventional',
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      assignee TEXT NOT NULL DEFAULT 'claude-code',
      tdd_enabled INTEGER NOT NULL DEFAULT 0,
      tdd_phase TEXT NOT NULL DEFAULT 'implement_only',
      mcps TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '[]',
      subagents TEXT NOT NULL DEFAULT '[]',
      depends_on TEXT NOT NULL DEFAULT '[]',
      parallel_group INTEGER,
      active_form TEXT,
      worktree_path TEXT,
      last_error TEXT,
      success_criteria TEXT NOT NULL DEFAULT '[]',
      guardrails TEXT NOT NULL DEFAULT '[]',
      epic TEXT,
      sprint TEXT,
      review_kind TEXT NOT NULL DEFAULT 'none',
      reviewer TEXT,
      additional_prompt TEXT,
      model TEXT,
      model_tier TEXT,
      component TEXT,
      external_dependencies TEXT NOT NULL DEFAULT '[]',
      test_cases TEXT NOT NULL DEFAULT '[]',
      failed_verify_count INTEGER NOT NULL DEFAULT 0,
      loop_policy TEXT,
      likely_paths TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedBoard(db: Database, id: string, name: string, updatedAt = "2026-07-25T00:00:00Z"): void {
  db.query(BOARD_INSERT).run(id, name, null, `/tmp/${id}`, updatedAt, updatedAt);
}

function seedTask(db: Database, opts: {
  id: string; boardId: string; title: string; status?: string;
  tddEnabled?: boolean; tddPhase?: string; dependsOn?: string[]; updatedAt?: string;
}): void {
  db.query(TASK_INSERT).run(
    opts.id, opts.boardId, opts.title, "some description", opts.status ?? "backlog",
    opts.tddEnabled ? 1 : 0, opts.tddPhase ?? "implement_only",
    JSON.stringify(opts.dependsOn ?? []),
    opts.updatedAt ?? "2026-07-25T00:00:00Z",
    opts.updatedAt ?? "2026-07-25T00:00:00Z",
  );
}

describe("state sync — PRD 3.1 bidirectional serialization", () => {
  test("serializeState → deserializeAndUpsert round-trips a full board+tasks graph", () => {
    const db = freshDb();
    seedBoard(db, "b1", "Alpha");
    seedTask(db, { id: "t1", boardId: "b1", title: "one", dependsOn: [] });
    seedTask(db, { id: "t2", boardId: "b1", title: "two", dependsOn: ["t1"], tddEnabled: true, tddPhase: "write_tests" });

    const state = serializeState(db);
    expect(state.version).toBe(1);
    expect(state.boards.length).toBe(1);
    expect(state.tasks.length).toBe(2);
    expect(state.tasks[1]!.depends_on).toBe('["t1"]');
    expect(state.tasks[1]!.tdd_enabled).toBe(1);
    expect(state.tasks[1]!.tdd_phase).toBe("write_tests");

    const empty = freshDb();
    const res = deserializeAndUpsert(empty, state);
    expect(res.boardsUpserted).toBe(1);
    expect(res.tasksUpserted).toBe(2);
    const board = empty.query("SELECT name FROM boards WHERE id = ?").get("b1") as { name: string };
    expect(board.name).toBe("Alpha");
    const t2 = empty.query("SELECT tdd_phase, depends_on FROM tasks WHERE id = 't2'").get() as { tdd_phase: string; depends_on: string };
    expect(t2.tdd_phase).toBe("write_tests");
    expect(t2.depends_on).toBe('["t1"]');
  });

  test("deserializeAndUpsert of the same state twice is a no-op (idempotent)", () => {
    const db = freshDb();
    seedBoard(db, "b1", "Alpha");
    seedTask(db, { id: "t1", boardId: "b1", title: "one" });
    const state = serializeState(db);

    const dest = freshDb();
    const first = deserializeAndUpsert(dest, state);
    const second = deserializeAndUpsert(dest, state);
    expect(first.tasksUpserted).toBe(1);
    expect(second.tasksUpserted).toBe(1);
    const count = dest.query("SELECT COUNT(*) as n FROM tasks").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("later updated_at wins; older imported entries do not clobber newer DB rows", () => {
    const db = freshDb();
    seedBoard(db, "b1", "Alpha");
    seedTask(db, { id: "t1", boardId: "b1", title: "newer local", status: "in_review", updatedAt: "2026-07-26T00:00:00Z" });
    const localBefore = serializeState(db);
    expect(localBefore.tasks[0]!.title).toBe("newer local");

    // Import a stale state that says the task title was "old", updated_at earlier.
    const staleTask = { ...localBefore.tasks[0]!, title: "old", updated_at: "2026-07-25T00:00:00Z" };
    const stale = { ...localBefore, tasks: [staleTask] };
    deserializeAndUpsert(db, stale);

    // Newer local title should stand.
    const row = db.query("SELECT title FROM tasks WHERE id = 't1'").get() as { title: string };
    expect(row.title).toBe("newer local");
  });

  test("unknown schema version → skipped, no rows written", () => {
    const db = freshDb();
    const bogus = { version: 999, exported_at: "x", boards: [], tasks: [{}] } as unknown as ReturnType<typeof serializeState>;
    const res = deserializeAndUpsert(db, bogus);
    expect(res.skippedVersion).toBe(true);
    expect(res.boardsUpserted).toBe(0);
  });

  test("writeStateFile → readStateFile round-trips (atomic write)", () => {
    const root = mkdtempSync(join(tmpdir(), "at-sync-"));
    try {
      const state = { version: 1, exported_at: "now", boards: [], tasks: [] } as ReturnType<typeof serializeState>;
      const path = writeStateFile(root, state);
      expect(path).toBe(statePath(root));
      const read = readStateFile(root);
      expect(read).toEqual(state);
      // No leftover .tmp
      expect(existsSync(`${path}.tmp`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exportToFile → hydrateFromFile end-to-end (a teammate flow)", () => {
    const root = mkdtempSync(join(tmpdir(), "at-sync-"));
    try {
      // Owner DB has the state; export.
      const owner = freshDb();
      seedBoard(owner, "b1", "Alpha");
      seedTask(owner, { id: "t1", boardId: "b1", title: "hello" });
      exportToFile(owner, root);

      // Teammate DB is empty; hydrate from the file.
      const teammate = freshDb();
      const res = hydrateFromFile(teammate, root);
      expect(res).not.toBeNull();
      expect(res!.boardsUpserted).toBe(1);
      expect(res!.tasksUpserted).toBe(1);
      const task = teammate.query("SELECT title FROM tasks WHERE id = 't1'").get() as { title: string };
      expect(task.title).toBe("hello");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hydrateFromFile returns null when no state file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "at-sync-"));
    try {
      const db = freshDb();
      expect(hydrateFromFile(db, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("startAutoSync writes on change, skips write when unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "at-sync-"));
    try {
      const db = freshDb();
      const handle = startAutoSync(db, root, 50);
      // Seed then flush — should write.
      seedBoard(db, "b1", "Alpha");
      handle.flush();
      const path = statePath(root);
      expect(existsSync(path)).toBe(true);
      const firstMtime = readFileSync(path, "utf8").length;

      // No changes → flush should be a no-op (content identical). We prove
      // this by rewriting our own copy over the file and confirming flush
      // does not restore it.
      writeFileSync(path, JSON.stringify({ sentinel: true }), "utf8");
      handle.flush();
      const after = readFileSync(path, "utf8");
      expect(after).toBe(JSON.stringify({ sentinel: true }));
      expect(after.length).not.toBe(firstMtime);

      // A real DB change → flush writes again.
      seedTask(db, { id: "t1", boardId: "b1", title: "new" });
      handle.flush();
      const reloaded = readStateFile(root);
      expect(reloaded!.tasks.length).toBe(1);

      handle.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
