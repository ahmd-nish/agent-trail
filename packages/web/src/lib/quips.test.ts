import { describe, test, expect } from "bun:test";
import {
  fillSlots,
  QuipEngine,
  parseQuipsYaml,
  DEFAULT_PLAYFUL,
  DEFAULT_DRY,
  type QuipPack,
} from "./quips.ts";

// Deterministic clock/RNG for every test — the engine's cooldown + shuffle
// are the whole point, so real time / real random would make this flaky.

function makeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
function fixedRandom(seq: number[]) {
  let i = 0;
  return () => {
    const v = seq[i % seq.length]!;
    i++;
    return v;
  };
}

describe("fillSlots", () => {
  test("replaces known slots", () => {
    expect(fillSlots("attempt {n}", { n: 3 })).toBe("attempt 3");
    expect(fillSlots("{taskName}: {n}", { taskName: "ship", n: 2 })).toBe("ship: 2");
  });
  test("empty for missing slots, collapses whitespace", () => {
    expect(fillSlots("  {a}  {b}  ", { a: "x" })).toBe("x");
    expect(fillSlots("hi {none}", {})).toBe("hi");
  });
});

describe("QuipEngine basic pick", () => {
  test("picks a line for a real event", () => {
    const clock = makeClock();
    const e = new QuipEngine({ now: clock.now, random: fixedRandom([0]) });
    const s = e.pick("test_fail_1");
    expect(s).not.toBeNull();
    expect(typeof s).toBe("string");
    expect(s!.length).toBeGreaterThan(0);
  });

  test("unknown / empty event → null", () => {
    // A pack that has no lines for `escalation`.
    const emptyPack: QuipPack = { tone: "playful", quips: {} };
    const e = new QuipEngine({ pack: emptyPack });
    expect(e.pick("escalation")).toBeNull();
  });

  test("tone off → always null", () => {
    const e = new QuipEngine({ tone: "off" });
    expect(e.pick("milestone", { done: 1, total: 3 })).toBeNull();
  });

  test("fills slots into template", () => {
    const clock = makeClock();
    const e = new QuipEngine({ pack: DEFAULT_DRY, tone: "dry", now: clock.now, random: fixedRandom([0]) });
    const s = e.pick("milestone", { done: 4, total: 10 });
    expect(s).toBe("4/10.");
  });
});

describe("QuipEngine cooldowns", () => {
  test("same event blocked by per-event cooldown", () => {
    const clock = makeClock();
    const e = new QuipEngine({
      now: clock.now, random: fixedRandom([0, 0]),
      perEventCooldownMs: 8000, globalCooldownMs: 100,
    });
    expect(e.pick("test_fail_1")).not.toBeNull();
    // Wait past the global cooldown but not the per-event.
    clock.advance(500);
    expect(e.pick("test_fail_1")).toBeNull();
    // Past the per-event too.
    clock.advance(8000);
    expect(e.pick("test_fail_1")).not.toBeNull();
  });

  test("different events blocked by global cooldown briefly", () => {
    const clock = makeClock();
    const e = new QuipEngine({
      now: clock.now, random: fixedRandom([0]),
      perEventCooldownMs: 100, globalCooldownMs: 4000,
    });
    expect(e.pick("test_fail_1")).not.toBeNull();
    clock.advance(1000);
    // A DIFFERENT event still hits the global cooldown.
    expect(e.pick("milestone", { done: 1, total: 2 })).toBeNull();
    clock.advance(4000);
    expect(e.pick("milestone", { done: 1, total: 2 })).not.toBeNull();
  });
});

describe("QuipEngine no-repeat shuffle", () => {
  test("consumes every line before repeating (per event)", () => {
    // Two lines for test_fail_1 in the default pack.
    const clock = makeClock();
    const smallPack: QuipPack = {
      tone: "playful",
      quips: { test_fail_1: ["A", "B"] },
    };
    const e = new QuipEngine({
      pack: smallPack, now: clock.now, random: fixedRandom([0, 0, 0]),
      perEventCooldownMs: 0, globalCooldownMs: 0,
    });
    const first = e.pick("test_fail_1");
    clock.advance(1);
    const second = e.pick("test_fail_1");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second); // must be different
    clock.advance(1);
    const third = e.pick("test_fail_1");
    expect(third).not.toBeNull(); // pool refills
  });
});

describe("QuipEngine setTone / setPack", () => {
  test("setTone off silences", () => {
    const e = new QuipEngine({ tone: "playful", random: fixedRandom([0]) });
    expect(e.pick("test_fail_1")).not.toBeNull();
    e.setTone("off");
    // Advance is unnecessary — tone gate is first.
    expect(e.pick("empty_board")).toBeNull();
  });

  test("setPack resets cooldowns", () => {
    const clock = makeClock();
    const e = new QuipEngine({ now: clock.now, random: fixedRandom([0]) });
    expect(e.pick("test_fail_1")).not.toBeNull();
    // Even without waiting, swapping the pack should let a fresh pick through
    // once the global cooldown is past.
    e.setPack(DEFAULT_DRY);
    clock.advance(4000);
    expect(e.pick("test_fail_1")).not.toBeNull();
  });
});

describe("parseQuipsYaml", () => {
  test("parses the minimal shape", () => {
    const pack = parseQuipsYaml(`
tone: playful
quips:
  test_fail_1:
    - "red. bold choice."
    - "one red. every green story starts here."
  milestone:
    - "{done}/{total} done."
`);
    expect(pack.tone).toBe("playful");
    expect(pack.quips.test_fail_1?.length).toBe(2);
    expect(pack.quips.milestone?.[0]).toBe("{done}/{total} done.");
  });

  test("throws when tone is missing", () => {
    expect(() => parseQuipsYaml("quips:\n  test_fail_1:\n    - \"x\"")).toThrow();
  });

  test("ignores comment lines", () => {
    const pack = parseQuipsYaml(`
# leading comment
tone: dry
quips:
  # section
  idle_board:
    - "idle."
`);
    expect(pack.quips.idle_board?.[0]).toBe("idle.");
  });
});

describe("default packs", () => {
  test("playful has every canonical event key", () => {
    const keys: Array<keyof typeof DEFAULT_PLAYFUL.quips> = [
      "test_fail_1", "test_fail_many", "escalation", "long_tool_streak",
      "cost_threshold", "milestone", "idle_board", "empty_board",
      "tests_green", "resumed", "budget_tripped", "decision_ticket",
      "task_completed", "task_error",
    ];
    for (const k of keys) {
      expect(DEFAULT_PLAYFUL.quips[k]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("dry pack mirrors playful keys", () => {
    for (const k of Object.keys(DEFAULT_PLAYFUL.quips)) {
      expect(DEFAULT_DRY.quips[k as keyof typeof DEFAULT_DRY.quips]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
