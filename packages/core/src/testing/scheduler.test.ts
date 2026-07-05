/**
 * Tests for the parallel test-case scheduler. The interesting properties:
 *   1. Independent cases run together (under the concurrency cap).
 *   2. Dependents wait for their parent to PASS.
 *   3. A failed parent SKIPS its descendants (not just one level — the whole
 *      subtree, since {{prev.X}} would unwind transitively).
 *   4. Sibling failures don't affect each other.
 *   5. Cycles are detected and the participating cases are skipped.
 */

import { describe, expect, it } from "bun:test";
import type { TestCase } from "../types/index.ts";
import { runInParallel, detectCycles } from "./scheduler.ts";

const c = (id: string, dependsOnCaseId?: string): TestCase => ({
  id,
  criterionIndex: 0,
  label: id,
  kind: "api",
  dependsOnCaseId,
});

/** Helper: build a `runCase` mock that records call order + concurrency. */
function recorder(opts: { passes?: Set<string>; fails?: Set<string>; delayMs?: number } = {}) {
  const passes = opts.passes ?? new Set();
  const fails = opts.fails ?? new Set();
  const delayMs = opts.delayMs ?? 0;
  const startOrder: string[] = [];
  const completionOrder: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const run = async (id: string): Promise<boolean> => {
    startOrder.push(id);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    inflight--;
    completionOrder.push(id);
    if (fails.has(id)) return false;
    if (passes.size > 0) return passes.has(id);
    return true; // default: pass
  };
  return { run, startOrder, completionOrder, getMaxInflight: () => maxInflight };
}

describe("detectCycles", () => {
  it("returns empty for an acyclic DAG", () => {
    expect(detectCycles([c("a"), c("b", "a"), c("c", "b")])).toEqual([]);
  });

  it("identifies a simple 2-node cycle", () => {
    expect(detectCycles([c("a", "b"), c("b", "a")])).toEqual(["a", "b"]);
  });

  it("identifies a 3-node cycle", () => {
    const ids = detectCycles([c("a", "c"), c("b", "a"), c("c", "b")]);
    expect(new Set(ids)).toEqual(new Set(["a", "b", "c"]));
  });

  it("treats deps pointing outside the input set as independent", () => {
    expect(detectCycles([c("a", "external-id-not-present")])).toEqual([]);
  });
});

describe("runInParallel — independent cases", () => {
  it("runs independent cases concurrently up to the cap", async () => {
    const cases = ["a", "b", "c", "d", "e"].map((id) => c(id));
    const rec = recorder({ delayMs: 20 });
    const res = await runInParallel(cases, rec.run, { concurrency: 3 });
    expect(res.passed).toBe(5);
    expect(res.failed).toBe(0);
    expect(rec.getMaxInflight()).toBe(3);
  });

  it("falls back to 1 when concurrency is 1 (purely sequential)", async () => {
    const cases = ["a", "b", "c"].map((id) => c(id));
    const rec = recorder({ delayMs: 10 });
    await runInParallel(cases, rec.run, { concurrency: 1 });
    expect(rec.getMaxInflight()).toBe(1);
  });

  it("clamps invalid concurrency values to at least 1", async () => {
    const cases = [c("a"), c("b")];
    const rec = recorder({ delayMs: 5 });
    await runInParallel(cases, rec.run, { concurrency: 0 });
    expect(rec.getMaxInflight()).toBe(1);
  });
});

describe("runInParallel — dependency ordering", () => {
  it("dependent case waits for its parent to start", async () => {
    // a → b. b should never start before a completes.
    const cases = [c("a"), c("b", "a")];
    const rec = recorder({ delayMs: 10 });
    await runInParallel(cases, rec.run, { concurrency: 4 });
    expect(rec.startOrder).toEqual(["a", "b"]);
  });

  it("siblings run in parallel after the shared parent", async () => {
    // a → b, a → c. Once a completes, b and c run together.
    const cases = [c("a"), c("b", "a"), c("c", "a")];
    const rec = recorder({ delayMs: 15 });
    await runInParallel(cases, rec.run, { concurrency: 4 });
    expect(rec.completionOrder).toEqual(["a", "b", "c"]);
    expect(rec.getMaxInflight()).toBeGreaterThanOrEqual(2);
  });
});

describe("runInParallel — failure cascade", () => {
  it("skips the descendant subtree when a parent fails", async () => {
    // a → b → c, and a sibling d that is independent.
    // a fails → b and c are skipped, d still runs.
    const cases = [c("a"), c("b", "a"), c("c", "b"), c("d")];
    const rec = recorder({ fails: new Set(["a"]) });
    const res = await runInParallel(cases, rec.run, { concurrency: 4 });
    expect(res.passed).toBe(1);   // d
    expect(res.failed).toBe(1);   // a
    expect(res.skipped).toBe(2);  // b, c
    expect(rec.startOrder).toEqual(["a", "d"]); // b, c never start
  });

  it("sibling failures are isolated — one failure doesn't poison the other", async () => {
    // a → b (passes), a → c (fails). c failing must not skip b.
    const cases = [c("a"), c("b", "a"), c("c", "a")];
    const rec = recorder({ fails: new Set(["c"]) });
    const res = await runInParallel(cases, rec.run, { concurrency: 4 });
    expect(res.passed).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.skipped).toBe(0);
  });

  it("a runCase that throws is treated as failed (and cascades)", async () => {
    const cases = [c("a"), c("b", "a")];
    const throwing = async (id: string): Promise<boolean> => {
      if (id === "a") throw new Error("boom");
      return true;
    };
    const res = await runInParallel(cases, throwing, { concurrency: 2 });
    expect(res.failed).toBe(1);
    expect(res.skipped).toBe(1);
  });
});

describe("runInParallel — cycle handling", () => {
  it("skips all cases participating in a cycle", async () => {
    const cases = [c("a", "b"), c("b", "a"), c("c")];
    const rec = recorder();
    const res = await runInParallel(cases, rec.run, { concurrency: 4 });
    expect(rec.startOrder).toEqual(["c"]);
    expect(res.skipped).toBe(2);
    expect(res.cycles.sort()).toEqual(["a", "b"]);
  });
});

describe("runInParallel — progress callback", () => {
  it("emits at start, on every transition, and at end", async () => {
    const cases = [c("a"), c("b")];
    const rec = recorder({ delayMs: 5 });
    const snapshots: Array<{ running: number; done: number }> = [];
    await runInParallel(cases, rec.run, {
      concurrency: 2,
      onProgress: (p) => snapshots.push({ running: p.running, done: p.done }),
    });
    // Must include at least:
    //   initial:    running=0 done=0
    //   after launch: running=2 done=0
    //   after both:   running=0 done=2
    expect(snapshots[0]).toEqual({ running: 0, done: 0 });
    expect(snapshots.at(-1)).toEqual({ running: 0, done: 2 });
    // Highwater includes a snapshot where running > 0
    expect(snapshots.some((s) => s.running > 0)).toBe(true);
  });

  it("statusById reflects per-case lifecycle", async () => {
    const cases = [c("a"), c("b", "a")];
    let final: Record<string, string> = {};
    await runInParallel(cases, async () => true, {
      concurrency: 2,
      onProgress: (p) => { final = { ...p.statusById }; },
    });
    expect(final).toEqual({ a: "passed", b: "passed" });
  });
});
