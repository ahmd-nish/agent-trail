import type { Database } from "bun:sqlite";
import { hasEdgeTable } from "./edges.ts";
import { pathUrns } from "./code-index.ts";
import { list } from "./store.ts";

// §5.3 — "the benchmark: your best marketing asset."
//
// projectmem's own paper flags the missing category-wide benchmark as
// its single most-valuable next result. This is our first pass: not a
// controlled A/B against a naive baseline (that needs a seeded corpus,
// deferred), but a live-repo report over the telemetry the tool has
// already been collecting since v1.0.
//
// The metrics reported here are the ones the doc calls out as headline:
//   - tokens/task                     (avg input + output per execution)
//   - discovery-cost proxy            (avg exploratory tool count is TBD;
//                                      reported as "unknown" until the
//                                      telemetry_events surface exposes it)
//   - repeat-failure prevention rate  (fraction of tasks where the risk
//                                      index would have warned at spawn
//                                      time — a lower-bound on gate value)
//   - context-reuse rate              (% of knowledge events consumed by
//                                      a task attributed to a different
//                                      actor — the multiplayer metric)
//   - time-to-first-green             (avg duration to first passing
//                                      verify_tests per task)
//   - iteration density               (avg iteration_memories per failed task)
//   - knowledge stock                 (event count by type)

export interface BenchReport {
  windowStart: string;
  windowEnd: string;
  tasks: {
    total: number;
    completed: number;
    failed: number;
    completionRate: number;
  };
  tokens: {
    totalInput: number;
    totalOutput: number;
    avgInputPerExecution: number;
    avgOutputPerExecution: number;
    /** Input tokens served from cache across executions that recorded it. */
    cacheReadTokens: number;
    /** Input tokens written to cache — the 1.25x premium a breakpoint costs. */
    cacheCreationTokens: number;
    /** cacheRead / totalInput. `null` when no execution has the breakdown yet
     *  (pre-v25 rows), which is distinct from a measured rate of 0. */
    cacheHitRate: number | null;
    /** Executions contributing to cacheHitRate — the sample size behind it. */
    cacheSampleSize: number;
  };
  timing: {
    avgDurationMs: number;
    avgTimeToFirstGreenMs: number | null;
  };
  loop: {
    executions: number;
    verifyPassRate: number;
    thrashOccurrences: number;
    avgIterationsPerFailedTask: number;
  };
  knowledge: {
    byType: Record<string, number>;
    totalActive: number;
    contextReuseRate: number;
    riskCoverage: number;
    /**
     * §8 — THE metric to own, because no tool in the category reports it.
     *
     * Fraction of tasks whose pack contained >= 1 knowledge event that was
     * (a) authored by a DIFFERENT actor and (b) joined by a `governs` edge to
     * a file the task ACTUALLY MODIFIED.
     *
     * Both clauses matter. (a) alone is contextReuseRate, which is vanity: it
     * counts facts that were present, not facts that were relevant. (b) turns
     * it into a claim about usefulness. Together they are the difference
     * between a shared brain and a shared folder.
     *
     * `null` when no task in the window recorded modified files — distinct
     * from a measured 0.
     */
    crossActorGovernanceRate: number | null;
    /** Tasks that had modified files to judge — the sample size behind it. */
    crossActorSampleSize: number;
  };
  notes: string[];
}

export interface BenchOptions {
  workspaceId?: string;
  projectId?: string;
  /** Only consider events / tasks strictly newer than this ISO date. */
  since?: string;
}

export function runBench(db: Database, opts: BenchOptions = {}): BenchReport {
  const since = opts.since ?? isoDaysAgo(30);
  const now = new Date().toISOString();

  // Bench must work against an event-log-only DB (fresh install, or an
  // export/import destination). Guard every non-knowledge table read.
  const has = (name: string): boolean =>
    !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

  // The cache columns arrive in migration v25. A DB that predates it — or a
  // minimal import target — still benches, it just reports cacheHitRate null.
  const hasCol = (table: string, col: string): boolean =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((r) => r.name === col);

  const taskRows = has("tasks") ? db.query(
    `SELECT id, status, created_at FROM tasks WHERE created_at >= ?`,
  ).all(since) as Array<{ id: string; status: string; created_at: string }> : [];
  const totalTasks = taskRows.length;
  const completedTasks = taskRows.filter((r) => r.status === "done" || r.status === "in_review").length;
  const failedTasks = taskRows.filter((r) => r.status === "failed" || r.status === "blocked").length;

  const hasCacheCols = has("executions") && hasCol("executions", "cache_read_input_tokens");
  const cacheSelect = hasCacheCols
    ? ", cache_read_input_tokens, cache_creation_input_tokens"
    : "";
  const execRows = has("executions") ? db.query(
    `SELECT total_input_tokens, total_output_tokens, duration_ms, status, task_id, started_at${cacheSelect}
     FROM executions WHERE started_at >= ?`,
  ).all(since) as Array<{
    total_input_tokens: number | null; total_output_tokens: number | null;
    duration_ms: number | null; status: string; task_id: string; started_at: string;
    cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null;
  }> : [];
  const totalInput = execRows.reduce((a, r) => a + (r.total_input_tokens ?? 0), 0);
  const totalOutput = execRows.reduce((a, r) => a + (r.total_output_tokens ?? 0), 0);

  // Only rows that actually recorded the breakdown count toward the rate.
  // Averaging over pre-v25 NULLs would silently report a hit rate near zero
  // and make a working cache look broken.
  const cacheRows = execRows.filter((r) => r.cache_read_input_tokens != null);
  const cacheReadTotal = cacheRows.reduce((a, r) => a + (r.cache_read_input_tokens ?? 0), 0);
  const cacheCreationTotal = cacheRows.reduce((a, r) => a + (r.cache_creation_input_tokens ?? 0), 0);
  const cacheDenom = cacheRows.reduce((a, r) => a + (r.total_input_tokens ?? 0), 0);
  const cacheHitRate = cacheDenom === 0 ? null : cacheReadTotal / cacheDenom;
  const withDuration = execRows.filter((r) => (r.duration_ms ?? 0) > 0);

  const executions = execRows.length;
  const completedExecs = execRows.filter((r) => r.status === "completed").length;
  const verifyPassRate = executions === 0 ? 0 : completedExecs / executions;

  // time to first green — for tasks that completed, earliest completed exec's duration.
  const firstGreens: number[] = [];
  const perTask = new Map<string, typeof execRows>();
  for (const r of execRows) {
    const arr = perTask.get(r.task_id) ?? [];
    arr.push(r);
    perTask.set(r.task_id, arr);
  }
  for (const [_taskId, execs] of perTask) {
    void _taskId;
    execs.sort((a, b) => a.started_at.localeCompare(b.started_at));
    const greenIdx = execs.findIndex((e) => e.status === "completed");
    if (greenIdx >= 0) {
      // Duration = sum of all executions up to and including the first green.
      const total = execs.slice(0, greenIdx + 1).reduce((a, e) => a + (e.duration_ms ?? 0), 0);
      if (total > 0) firstGreens.push(total);
    }
  }

  // Thrash count = count of gotcha events whose subject starts with "thrash".
  const thrashRows = db.query(
    `SELECT COUNT(*) AS n FROM knowledge_events
     WHERE type = 'gotcha' AND subject LIKE 'thrash%' AND valid_from >= ?`,
  ).get(since) as { n: number };
  const thrashOccurrences = thrashRows.n;

  // Iteration memories — average iterations for failed tasks.
  const iterRows = has("iteration_memories") ? db.query(
    `SELECT task_id, COUNT(*) AS n FROM iteration_memories
     WHERE created_at >= ? GROUP BY task_id`,
  ).all(since) as Array<{ task_id: string; n: number }> : [];
  const iterationsAvg = iterRows.length === 0 ? 0
    : iterRows.reduce((a, r) => a + r.n, 0) / iterRows.length;

  // Knowledge stock.
  const typeRows = db.query(
    `SELECT type, COUNT(*) AS n FROM knowledge_events
     WHERE superseded_by IS NULL AND valid_from >= ?
     GROUP BY type`,
  ).all(since) as Array<{ type: string; n: number }>;
  const byType: Record<string, number> = {};
  for (const r of typeRows) byType[r.type] = r.n;
  const totalActive = Object.values(byType).reduce((a, b) => a + b, 0);

  // Context reuse rate — the multiplayer metric.
  //   fraction of active knowledge events whose actor differs from the
  //   git user.name that ran this bench. Single-actor local runs = 0.
  //   Two teammates on a shared DB = the actually-interesting number.
  const distinctActors = list(db, { activeOnly: true, workspaceId: opts.workspaceId, projectId: opts.projectId });
  const actorSet = new Set(distinctActors.map((e) => e.actorId));
  const contextReuseRate = actorSet.size <= 1 ? 0 : (actorSet.size - 1) / actorSet.size;

  // Risk coverage — fraction of tasks whose likely_paths intersect any
  // failed_attempt/gotcha event in the log. A lower bound on how often
  // the governance gate would have had something to say.
  let riskCovered = 0;
  const tasksWithPaths = has("tasks") ? db.query(
    `SELECT id, likely_paths FROM tasks WHERE created_at >= ? AND likely_paths != '[]'`,
  ).all(since) as Array<{ id: string; likely_paths: string }> : [];
  const riskEventRows = db.query(
    `SELECT paths, scope FROM knowledge_events
     WHERE type IN ('failed_attempt','gotcha') AND superseded_by IS NULL AND valid_from >= ?`,
  ).all(since) as Array<{ paths: string; scope: string }>;
  for (const t of tasksWithPaths) {
    const tPaths = safeParsePaths(t.likely_paths);
    for (const e of riskEventRows) {
      const ePaths = safeParsePaths(e.paths);
      const hit = tPaths.some((p) =>
        ePaths.some((ep) => p === ep || p.startsWith(`${ep}/`) || ep.startsWith(`${p}/`)) ||
        (e.scope.startsWith("module:") && (() => {
          const m = e.scope.slice("module:".length);
          return tPaths.some((p) => p === m || p.startsWith(`${m}/`));
        })()),
      );
      if (hit) { riskCovered++; break; }
    }
  }
  const riskCoverage = tasksWithPaths.length === 0 ? 0 : riskCovered / tasksWithPaths.length;

  const notes: string[] = [];
  if (executions === 0) notes.push("no executions in window — try `--since` older than default 30d");
  if (thrashOccurrences === 0 && executions > 5) notes.push("no thrash occurrences — either the loop is well-behaved or thrash detection is off");
  if (actorSet.size <= 1) notes.push("single-actor run: context-reuse is definitionally 0 until a teammate shares the log");
  notes.push("token savings vs a naive-context baseline require the deferred seeded-corpus A/B — this report is over live telemetry only");

  // ── §8 cross-actor governance rate ────────────────────────────────────────
  const cross = (() => {
    if (!hasEdgeTable(db)) return { rate: null as number | null, sample: 0 };
    let sample = 0, hits = 0;
    for (const t of taskRows) {
      // Files the task ACTUALLY modified, taken from its own artifact_summary.
      // likelyPaths is a prediction; this metric only credits real overlap.
      const own = db.query(
        `SELECT paths, actor_id FROM knowledge_events
          WHERE task_id = ? AND type = 'artifact_summary'`,
      ).all(t.id) as Array<{ paths: string; actor_id: string }>;
      const modified = new Set<string>();
      const ownActors = new Set<string>();
      for (const r of own) {
        ownActors.add(r.actor_id);
        for (const p of safeJson(r.paths)) modified.add(p);
      }
      if (modified.size === 0) continue;
      sample++;

      const urns = [...modified].flatMap((p) => pathUrns(p));
      if (urns.length === 0) continue;
      const placeholders = urns.map(() => "?").join(",");
      const governing = db.query(
        `SELECT DISTINCT e.actor_id FROM knowledge_events e
           JOIN knowledge_edges g ON g.src = 'kev:' || e.id
          WHERE g.dst IN (${placeholders})
            AND g.kind = 'governs'
            AND e.superseded_by IS NULL
            AND (e.task_id IS NULL OR e.task_id != ?)`,
      ).all(...urns, t.id) as Array<{ actor_id: string }>;

      if (governing.some((g) => !ownActors.has(g.actor_id))) hits++;
    }
    return { rate: sample === 0 ? null : hits / sample, sample };
  })();

  return {
    windowStart: since,
    windowEnd: now,
    tasks: {
      total: totalTasks,
      completed: completedTasks,
      failed: failedTasks,
      completionRate: totalTasks === 0 ? 0 : completedTasks / totalTasks,
    },
    tokens: {
      totalInput, totalOutput,
      avgInputPerExecution: executions === 0 ? 0 : totalInput / executions,
      avgOutputPerExecution: executions === 0 ? 0 : totalOutput / executions,
      cacheReadTokens: cacheReadTotal,
      cacheCreationTokens: cacheCreationTotal,
      cacheHitRate,
      cacheSampleSize: cacheRows.length,
    },
    timing: {
      avgDurationMs: withDuration.length === 0 ? 0
        : withDuration.reduce((a, r) => a + (r.duration_ms ?? 0), 0) / withDuration.length,
      avgTimeToFirstGreenMs: firstGreens.length === 0 ? null
        : firstGreens.reduce((a, b) => a + b, 0) / firstGreens.length,
    },
    loop: {
      executions,
      verifyPassRate,
      thrashOccurrences,
      avgIterationsPerFailedTask: iterationsAvg,
    },
    knowledge: {
      byType,
      totalActive,
      contextReuseRate,
      riskCoverage,
      crossActorGovernanceRate: cross.rate,
      crossActorSampleSize: cross.sample,
    },
    notes,
  };
}

function safeParsePaths(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}


function safeJson(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
