/**
 * Parallel test-case scheduler (Phase 4a).
 *
 * Builds a DAG from `TestCase.dependsOnCaseId` and runs cases concurrently
 * up to a cap. A dependent case is held back until its parent settles
 * (passed or failed). If a parent fails, its dependents are SKIPPED — they
 * can't reuse a {{prev.X}} value that never materialized.
 *
 * Pure orchestration: the caller supplies `runCase(id) => Promise<boolean>`,
 * the scheduler decides what to run when. No DB, no React, no fetch.
 */
import type { TestCase } from "../types/index.ts";

export type CaseStatus = "queued" | "running" | "passed" | "failed" | "skipped";

export interface SchedulerProgress {
  total: number;
  done: number;
  running: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Current per-case status — useful for live UI badges. */
  statusById: Record<string, CaseStatus>;
}

export interface SchedulerOpts {
  /** Maximum cases running concurrently. Defaults to 4. */
  concurrency?: number;
  /** Called every time a case status changes. */
  onProgress?: (p: SchedulerProgress) => void;
}

export interface SchedulerResult {
  passed: number;
  failed: number;
  skipped: number;
  /** Cases the scheduler refused to run because of a dependency cycle. */
  cycles: string[];
}

/**
 * Detect a dependsOnCaseId cycle among the provided cases. Returns the IDs
 * of all cases participating in any cycle. Cases pointing to dependencies
 * NOT in the input set are treated as independent (dep skipped).
 */
export function detectCycles(cases: TestCase[]): string[] {
  const ids = new Set(cases.map((c) => c.id));
  const dep = new Map<string, string | null>();
  for (const c of cases) {
    const d = c.dependsOnCaseId && ids.has(c.dependsOnCaseId) ? c.dependsOnCaseId : null;
    dep.set(c.id, d);
  }

  const inCycle = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 in-stack, 2 done
  for (const startId of ids) {
    if (state.get(startId)) continue;
    const stack: string[] = [];
    let cur: string | null = startId;
    while (cur !== null) {
      if (state.get(cur) === 1) {
        // back edge — collect everything from cur back to top of stack
        const idx = stack.indexOf(cur);
        for (let i = idx; i < stack.length; i++) inCycle.add(stack[i]!);
        break;
      }
      if (state.get(cur) === 2) break;
      state.set(cur, 1);
      stack.push(cur);
      cur = dep.get(cur) ?? null;
    }
    for (const s of stack) state.set(s, 2);
  }
  return [...inCycle].sort();
}

/**
 * Run a set of test cases in parallel, respecting dependsOnCaseId order.
 * The caller's `runCase` performs the actual work (HTTP request, assertion
 * eval, persistence) and returns true/false for pass/fail.
 *
 * Returns once every case has settled (passed, failed, or skipped).
 */
export async function runInParallel(
  cases: TestCase[],
  runCase: (id: string) => Promise<boolean>,
  opts: SchedulerOpts = {},
): Promise<SchedulerResult> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
  const idSet = new Set(cases.map((c) => c.id));
  const cycles = detectCycles(cases);
  const cycleSet = new Set(cycles);

  // Build dependency + reverse-dependency maps. A dep pointing outside the
  // input set is treated as "satisfied" (we have no way to wait for it).
  const dep = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  for (const c of cases) {
    const d = c.dependsOnCaseId && idSet.has(c.dependsOnCaseId) && !cycleSet.has(c.id)
      ? c.dependsOnCaseId
      : null;
    dep.set(c.id, d);
    if (d) {
      if (!children.has(d)) children.set(d, []);
      children.get(d)!.push(c.id);
    }
  }

  const statusById: Record<string, CaseStatus> = {};
  for (const c of cases) statusById[c.id] = cycleSet.has(c.id) ? "skipped" : "queued";

  // Counts for progress reporting
  let passed = 0, failed = 0, skipped = cycles.length, running = 0, done = cycles.length;
  const total = cases.length;

  const emit = () => opts.onProgress?.({
    total, done, running, passed, failed, skipped,
    statusById: { ...statusById },
  });
  emit();

  // Ready = case is queued AND its parent (if any) has passed. We re-derive
  // on every settle rather than maintaining a sorted ready queue — N is small
  // enough that O(N) re-scan per settle is fine and keeps the code simple.
  const isReady = (id: string): boolean => {
    if (statusById[id] !== "queued") return false;
    const d = dep.get(id);
    if (!d) return true;
    return statusById[d] === "passed";
  };

  // Skip a case (and its descendants) when its parent failed.
  const skipSubtree = (rootId: string): void => {
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (statusById[id] !== "queued") continue;
      statusById[id] = "skipped";
      skipped++; done++;
      for (const child of children.get(id) ?? []) queue.push(child);
    }
  };

  // Track in-flight promises so we can await any-completion.
  const inflight = new Map<string, Promise<void>>();

  const launch = (id: string): void => {
    statusById[id] = "running";
    running++;
    emit();
    const p = runCase(id)
      .then((ok) => {
        statusById[id] = ok ? "passed" : "failed";
        if (ok) passed++; else failed++;
        running--; done++;
        if (!ok) {
          // Cascade-skip descendants — they depend on a value that won't exist.
          for (const child of children.get(id) ?? []) skipSubtree(child);
        }
      })
      .catch(() => {
        // runCase rejected unexpectedly — treat as failed but don't crash.
        statusById[id] = "failed";
        failed++; running--; done++;
        for (const child of children.get(id) ?? []) skipSubtree(child);
      })
      .finally(() => {
        inflight.delete(id);
        emit();
      });
    inflight.set(id, p);
  };

  const fillSlots = (): void => {
    while (running < concurrency) {
      const next = cases.find((c) => isReady(c.id));
      if (!next) break;
      launch(next.id);
    }
  };

  fillSlots();
  while (inflight.size > 0) {
    await Promise.race(inflight.values());
    fillSlots();
  }

  return { passed, failed, skipped, cycles };
}
