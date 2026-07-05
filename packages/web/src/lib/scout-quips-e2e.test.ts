// End-to-end test for the Scout quip pipeline: real Task snapshots →
// diffTasksToEvents → QuipEngine → picked line. No mocks except a fixed clock
// and deterministic RNG. This is what happens in the browser when the polling
// loop reports new task state — minus the React render.

import { describe, test, expect } from "bun:test";
import type { Task } from "../../../core/src/types/index.ts";
import { diffTasksToEvents, makeDiffState } from "./useScoutQuips.ts";
import { QuipEngine, DEFAULT_PLAYFUL, DEFAULT_DRY } from "./quips.ts";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

let idCounter = 0;
function T(over: Partial<Task> = {}): Task {
  return {
    id: over.id ?? `t${++idCounter}`,
    boardId: "b1",
    title: over.title ?? "Ship a feature",
    description: "",
    status: "backlog",
    priority: "med",
    assignee: "claude-code",
    tddEnabled: false,
    tddPhase: null,
    mcps: [],
    skills: [],
    subagents: [],
    dependsOn: [],
    parallelGroup: null,
    activeForm: null,
    worktreePath: null,
    lastError: null,
    successCriteria: [],
    guardrails: [],
    epic: null,
    sprint: null,
    reviewKind: "none",
    reviewer: null,
    additionalPrompt: null,
    model: null,
    modelTier: null,
    component: null,
    externalDependencies: [],
    testCases: [],
    createdAt: "2026-07-05T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
    ...over,
  };
}

function makeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
function fixed(seq: number[]) {
  let i = 0;
  return () => (seq[i++ % seq.length] ?? 0);
}

/** Drive one full board tick: run the diff, then push every emitted event
 *  through the engine and collect the resulting lines (nulls omitted).  */
function tick(state: ReturnType<typeof makeDiffState>, engine: QuipEngine, tasks: Task[]): string[] {
  const evs = diffTasksToEvents(state, tasks);
  const out: string[] = [];
  for (const ev of evs) {
    const line = engine.pick(ev.event, ev.slots);
    if (line) out.push(line);
  }
  return out;
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

describe("Scout quips E2E: full board lifecycle", () => {
  test("first red on a task → test_fail_1 with taskName slot filled", () => {
    const clock = makeClock();
    const engine = new QuipEngine({
      now: clock.now, random: fixed([0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const state = makeDiffState();

    const t1 = T({ id: "A", title: "Add rate limiter", status: "in_progress" });
    // First tick — establish baseline. Should emit nothing.
    expect(tick(state, engine, [t1])).toEqual([]);

    // Now it goes red.
    const t1Red = { ...t1, status: "blocked" as const, lastError: "AssertionError in tests" };
    const lines = tick(state, engine, [t1Red]);
    expect(lines.length).toBe(1);
    // Line must be one of the test_fail_1 templates — check the phrase from index 0.
    expect(lines[0]).toBe("red. bold choice. let's see the rewrite.");
  });

  test("three fails on same task → test_fail_many with n=3 slot", () => {
    const clock = makeClock();
    const engine = new QuipEngine({
      now: clock.now, random: fixed([0, 0, 0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const state = makeDiffState();

    let t = T({ id: "A", title: "webhook retry", status: "in_progress" });
    tick(state, engine, [t]);

    for (let i = 0; i < 3; i++) {
      t = { ...t, status: "in_progress", lastError: null };
      tick(state, engine, [t]);
      clock.advance(100);
      t = { ...t, status: "blocked" as const, lastError: `run ${i}: red` };
      const lines = tick(state, engine, [t]);
      // After the 3rd red we expect test_fail_many; earlier reds emit test_fail_1
      if (i === 2) {
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain("webhook retry");
        expect(lines[0]).toContain("3"); // n slot present
      }
    }
  });

  test("budget/cap in error message → budget_tripped instead of test_fail_1", () => {
    const engine = new QuipEngine({
      random: fixed([0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const state = makeDiffState();

    const t = T({ id: "A", title: "long agentic loop", status: "in_progress" });
    tick(state, engine, [t]);

    const t2 = { ...t, status: "blocked" as const, lastError: "cost budget cap exceeded ($0.50)" };
    const lines = tick(state, engine, [t2]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe("budget cap. we killed it before it killed the wallet.");
  });

  test("red → green triggers tests_green + failCount reset", () => {
    const engine = new QuipEngine({
      random: fixed([0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const state = makeDiffState();

    let t = T({ id: "A", title: "parser", status: "in_progress" });
    tick(state, engine, [t]);

    t = { ...t, status: "blocked", lastError: "test failed" };
    tick(state, engine, [t]);

    t = { ...t, status: "done", lastError: null };
    const lines = tick(state, engine, [t]);
    // milestone (1/1), task_completed, tests_green — 3 events total.
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe("1/1 done. the backlog fears you.");
    // Last of the three is tests_green.
    expect(lines.at(-1)).toBe("green. finally. i knew you had it.");
  });

  test("milestone fires on strict done-count increase, only once per bump", () => {
    const engine = new QuipEngine({
      random: fixed([0, 0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const state = makeDiffState();

    const a = T({ id: "A", title: "one" });
    const b = T({ id: "B", title: "two" });
    tick(state, engine, [a, b]);

    // A moves to done — 1/2 milestone fires.
    const first = tick(state, engine, [{ ...a, status: "done" }, b]);
    expect(first.some((l) => l.includes("1/2"))).toBe(true);

    // No further change — milestone must NOT fire again.
    const second = tick(state, engine, [{ ...a, status: "done" }, b]);
    expect(second.filter((l) => l.includes("1/2"))).toEqual([]);

    // Now B moves too — 2/2.
    const third = tick(state, engine, [{ ...a, status: "done" }, { ...b, status: "done" }]);
    expect(third.some((l) => l.includes("2/2"))).toBe(true);
  });

  test("task acquires activeForm while blocked → decision_ticket", () => {
    const engine = new QuipEngine({
      random: fixed([0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const state = makeDiffState();

    let t = T({ id: "A", status: "in_progress", activeForm: null });
    tick(state, engine, [t]);

    // Directly transitions to blocked with an activeForm (ask_human style).
    t = { ...t, status: "blocked", activeForm: "Choose migration strategy" };
    const lines = tick(state, engine, [t]);
    expect(lines).toContain("a task needs your call.");
  });

  test("cooldown suppresses back-to-back same-event fires", () => {
    const clock = makeClock();
    const engine = new QuipEngine({
      now: clock.now, random: fixed([0, 0, 0]),
      perEventCooldownMs: 8000, globalCooldownMs: 3500,
    });
    const state = makeDiffState();

    const t1 = T({ id: "A", status: "in_progress" });
    const t2 = T({ id: "B", status: "in_progress" });
    tick(state, engine, [t1, t2]);

    // Both fail red in the same tick — engine emits one, suppresses one.
    const lines = tick(state, engine, [
      { ...t1, status: "blocked", lastError: "e1" },
      { ...t2, status: "blocked", lastError: "e2" },
    ]);
    expect(lines.length).toBe(1);

    // Wait past the cooldowns; a third fail lands.
    clock.advance(9000);
    const t3 = T({ id: "C", status: "in_progress" });
    tick(state, engine, [
      { ...t1, status: "blocked", lastError: "e1" },
      { ...t2, status: "blocked", lastError: "e2" },
      t3,
    ]);
    const t3red = { ...t3, status: "blocked" as const, lastError: "e3" };
    const post = tick(state, engine, [
      { ...t1, status: "blocked", lastError: "e1" },
      { ...t2, status: "blocked", lastError: "e2" },
      t3red,
    ]);
    expect(post.length).toBe(1);
  });

  test("tone off silences the whole pipeline even with fireable events", () => {
    const engine = new QuipEngine({
      tone: "off",
      random: fixed([0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const state = makeDiffState();

    const t = T({ id: "A", status: "in_progress" });
    tick(state, engine, [t]);
    const lines = tick(state, engine, [{ ...t, status: "blocked", lastError: "boom" }]);
    expect(lines).toEqual([]);
  });

  test("dry pack ships terser lines for the same events", () => {
    const engine = new QuipEngine({
      pack: DEFAULT_DRY, tone: "dry",
      random: fixed([0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const state = makeDiffState();
    const t = T({ id: "A", status: "in_progress" });
    tick(state, engine, [t]);
    const lines = tick(state, engine, [{ ...t, status: "blocked", lastError: "x" }]);
    expect(lines).toEqual(["test failed."]);
  });

  test("deleted task doesn't leak into next tick's diff", () => {
    const engine = new QuipEngine({
      random: fixed([0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const state = makeDiffState();

    const a = T({ id: "A", status: "in_progress" });
    tick(state, engine, [a]);
    // Delete A entirely — state.prior should drop it.
    tick(state, engine, []);
    // Reintroduce with same id but as a fresh task (no prior status).
    const aFresh = T({ id: "A", status: "backlog" });
    const lines = tick(state, engine, [aFresh]);
    expect(lines).toEqual([]); // no phantom transitions
  });
});

describe("Scout quips E2E: realistic multi-tick session", () => {
  test("PRD-drop → 3 tasks: some fail, then all green", () => {
    const clock = makeClock();
    const engine = new QuipEngine({
      pack: DEFAULT_PLAYFUL, tone: "playful",
      now: clock.now, random: fixed([0, 1, 0, 1, 0]),
      // Realistic cooldowns kept low to see multiple beats.
      perEventCooldownMs: 1000, globalCooldownMs: 500,
    });
    const state = makeDiffState();

    let a = T({ id: "A", title: "auth middleware", status: "in_progress" });
    let b = T({ id: "B", title: "rate limiter",    status: "in_progress" });
    let c = T({ id: "C", title: "webhook retry",   status: "in_progress" });
    tick(state, engine, [a, b, c]);

    // Tick 1: A fails red.
    a = { ...a, status: "blocked", lastError: "expected 200 got 404" };
    let out = tick(state, engine, [a, b, c]);
    expect(out.length).toBe(1);

    clock.advance(2000);
    // Tick 2: B goes green (done).
    b = { ...b, status: "done" };
    out = tick(state, engine, [a, b, c]);
    // milestone (1/3) + task_completed — expect exactly one line through the
    // engine because of global cooldown, but the milestone line goes first.
    expect(out.some((l) => l.includes("1/3"))).toBe(true);

    clock.advance(2000);
    // Tick 3: A recovers green.
    a = { ...a, status: "done", lastError: null };
    out = tick(state, engine, [a, b, c]);
    // milestone (2/3) + task_completed + tests_green — some suppressed by
    // global cooldown, but a non-zero number must come through.
    expect(out.length).toBeGreaterThan(0);

    clock.advance(4000);
    // Tick 4: C finishes.
    c = { ...c, status: "done" };
    out = tick(state, engine, [a, b, c]);
    expect(out.some((l) => l.includes("3/3"))).toBe(true);
  });
});
