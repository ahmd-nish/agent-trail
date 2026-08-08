import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { append } from "./store.ts";
import { runBench } from "./bench.ts";
import { KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES } from "./schema.ts";
import type { NewKnowledgeEvent } from "./types.ts";

// The bench queries tasks + executions + iteration_memories tables that
// only exist in the server's full schema. For unit tests, we recreate the
// minimum subset here (schema.sql-style) so the bench can be tested
// without spinning up the whole server.
const MINIMAL_TASKS_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  likely_paths TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  total_input_tokens INTEGER,
  total_output_tokens INTEGER,
  duration_ms INTEGER,
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS iteration_memories (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);`;

function freshDb() {
  const db = new Database(":memory:");
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) db.exec(s);
  db.exec(MINIMAL_TASKS_DDL);
  return db;
}

function ev(o: Partial<NewKnowledgeEvent> = {}): NewKnowledgeEvent {
  return {
    workspaceId: "local", projectId: "test",
    actorKind: "human", actorId: "nish@x", actorName: "Nish",
    taskId: null, executionId: null,
    type: "decision", scope: "project",
    subject: "sub", body: "body",
    paths: [], confidence: "ruling", supersedes: null,
    ...o,
  };
}

function seedTask(db: Database, id: string, status: string, likelyPaths: string[] = []) {
  db.query("INSERT INTO tasks (id, status, created_at, likely_paths) VALUES (?, ?, ?, ?)").run(
    id, status, new Date().toISOString(), JSON.stringify(likelyPaths),
  );
}

function seedExec(db: Database, opts: {
  id: string; taskId: string; status: string;
  input?: number; output?: number; duration?: number;
}) {
  db.query("INSERT INTO executions (id, task_id, status, total_input_tokens, total_output_tokens, duration_ms, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(opts.id, opts.taskId, opts.status, opts.input ?? 0, opts.output ?? 0, opts.duration ?? 0, new Date().toISOString());
}

describe("runBench()", () => {
  test("empty DB returns a report with zero everything", () => {
    const rpt = runBench(freshDb());
    expect(rpt.tasks.total).toBe(0);
    expect(rpt.tokens.totalInput).toBe(0);
    expect(rpt.loop.executions).toBe(0);
    expect(rpt.knowledge.totalActive).toBe(0);
  });

  test("computes token averages + completion rate", () => {
    const db = freshDb();
    seedTask(db, "t1", "done");
    seedTask(db, "t2", "in_review");
    seedTask(db, "t3", "failed");
    seedExec(db, { id: "e1", taskId: "t1", status: "completed", input: 1000, output: 500, duration: 5000 });
    seedExec(db, { id: "e2", taskId: "t2", status: "completed", input: 2000, output: 1000, duration: 10000 });
    seedExec(db, { id: "e3", taskId: "t3", status: "failed",    input: 3000, output: 800,  duration: 15000 });

    const rpt = runBench(db);
    expect(rpt.tasks.total).toBe(3);
    expect(rpt.tasks.completionRate).toBeCloseTo(2 / 3, 4);
    expect(rpt.tokens.totalInput).toBe(6000);
    expect(rpt.tokens.avgInputPerExecution).toBe(2000);
    expect(rpt.loop.executions).toBe(3);
    expect(rpt.loop.verifyPassRate).toBeCloseTo(2 / 3, 4);
    expect(rpt.timing.avgDurationMs).toBe(10000);
  });

  test("counts events by type + zero context-reuse for single actor", () => {
    const db = freshDb();
    append(db, ev({ type: "decision" }));
    append(db, ev({ type: "convention", subject: "convention" }));
    append(db, ev({ type: "gotcha", subject: "gotcha here" }));
    const rpt = runBench(db);
    expect(rpt.knowledge.byType["decision"]).toBe(1);
    expect(rpt.knowledge.byType["convention"]).toBe(1);
    expect(rpt.knowledge.byType["gotcha"]).toBe(1);
    expect(rpt.knowledge.totalActive).toBe(3);
    expect(rpt.knowledge.contextReuseRate).toBe(0);
  });

  test("context-reuse rate rises when multiple actors are present", () => {
    const db = freshDb();
    append(db, ev({ subject: "nish rule", actorId: "nish@x", actorName: "Nish" }));
    append(db, ev({ subject: "alice rule", actorId: "alice@x", actorName: "Alice" }));
    append(db, ev({ subject: "bob rule", actorId: "bob@x", actorName: "Bob" }));
    const rpt = runBench(db);
    // 3 distinct actors → (3-1)/3 = 0.666
    expect(rpt.knowledge.contextReuseRate).toBeCloseTo(2 / 3, 4);
  });

  test("counts thrash from gotcha events with subject starting with 'thrash'", () => {
    const db = freshDb();
    append(db, ev({ type: "gotcha", subject: "thrash on t1 · same-error", body: "" }));
    append(db, ev({ type: "gotcha", subject: "auth token expires", body: "" }));
    const rpt = runBench(db);
    expect(rpt.loop.thrashOccurrences).toBe(1);
  });

  test("risk coverage — task whose likely_paths hit a prior failed_attempt", () => {
    const db = freshDb();
    seedTask(db, "t1", "in_progress", ["packages/core/auth.ts"]);
    seedTask(db, "t2", "in_progress", ["packages/core/other.ts"]);
    append(db, ev({ type: "failed_attempt", paths: ["packages/core/auth.ts"], subject: "iter 1 fail" }));
    const rpt = runBench(db);
    // 1 of 2 tasks has paths that intersect a failed_attempt
    expect(rpt.knowledge.riskCoverage).toBeCloseTo(0.5, 4);
  });

  // knowledgelayer-v2 §2 — cache-hit rate, §4.4's only feedback signal.
  describe("cache-hit rate", () => {
    function dbWithCacheCols() {
      const db = freshDb();
      db.exec("ALTER TABLE executions ADD COLUMN cache_read_input_tokens INTEGER");
      db.exec("ALTER TABLE executions ADD COLUMN cache_creation_input_tokens INTEGER");
      return db;
    }
    function seedCacheExec(db: Database, id: string, total: number, read: number | null, creation = 0) {
      db.query(
        `INSERT INTO executions (id, task_id, status, total_input_tokens, total_output_tokens,
           duration_ms, started_at, cache_read_input_tokens, cache_creation_input_tokens)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(id, "t1", "completed", total, 0, 0, new Date().toISOString(), read, creation);
    }

    test("null — not 0 — when the columns predate migration v25", () => {
      const db = freshDb();
      seedTask(db, "t1", "done");
      seedExec(db, { id: "e1", taskId: "t1", status: "completed", input: 1000 });
      const rpt = runBench(db);
      // A DB that never recorded the breakdown must not report a 0% hit rate;
      // that would read as "caching is broken" rather than "not measured".
      expect(rpt.tokens.cacheHitRate).toBeNull();
      expect(rpt.tokens.cacheSampleSize).toBe(0);
    });

    test("computes read / total across rows that recorded it", () => {
      const db = dbWithCacheCols();
      seedTask(db, "t1", "done");
      seedCacheExec(db, "e1", 1000, 800, 100);
      seedCacheExec(db, "e2", 1000, 600, 50);
      const rpt = runBench(db);
      expect(rpt.tokens.cacheHitRate).toBeCloseTo(0.7, 4);   // 1400 / 2000
      expect(rpt.tokens.cacheReadTokens).toBe(1400);
      expect(rpt.tokens.cacheCreationTokens).toBe(150);
      expect(rpt.tokens.cacheSampleSize).toBe(2);
    });

    test("pre-v25 NULL rows are excluded from the denominator, not counted as misses", () => {
      const db = dbWithCacheCols();
      seedTask(db, "t1", "done");
      seedCacheExec(db, "e1", 1000, 800);
      seedCacheExec(db, "e2", 9000, null);   // legacy row — never measured
      const rpt = runBench(db);
      // 800/1000, not 800/10000 — the unmeasured row must not drag the rate down.
      expect(rpt.tokens.cacheHitRate).toBeCloseTo(0.8, 4);
      expect(rpt.tokens.cacheSampleSize).toBe(1);
      // but it still counts toward overall token totals
      expect(rpt.tokens.totalInput).toBe(10000);
    });

    test("a measured 0% hit rate is reported as 0, distinct from null", () => {
      const db = dbWithCacheCols();
      seedTask(db, "t1", "done");
      seedCacheExec(db, "e1", 1000, 0);
      const rpt = runBench(db);
      expect(rpt.tokens.cacheHitRate).toBe(0);
      expect(rpt.tokens.cacheSampleSize).toBe(1);
    });
  });
});
