import { describe, test, expect } from "bun:test";
import { defaultLoopPolicy, resolveLoopPolicy, parseLoopPolicy } from "./policy.ts";

describe("loopPolicy — PRD §5.1", () => {
  test("TDD default: pev, tests in stack, escalateAfterFailures=2, thrash on", () => {
    const p = defaultLoopPolicy(true);
    expect(p.pattern).toBe("pev");
    expect(p.verificationStack).toEqual(["tests"]);
    expect(p.escalation.escalateAfterFailures).toBe(2);
    expect(p.escalation.thrashDetection).toBe(true);
  });

  test("single-shot default (implement_only): no loop, no escalation, no thrash", () => {
    const p = defaultLoopPolicy(false);
    expect(p.pattern).toBe("single_shot");
    expect(p.termination.maxIterations).toBe(1);
    expect(p.escalation.thrashDetection).toBe(false);
  });

  test("resolveLoopPolicy merges a partial — untouched fields keep defaults", () => {
    const p = resolveLoopPolicy(true, { escalation: { escalateAfterFailures: 4 } });
    expect(p.escalation.escalateAfterFailures).toBe(4);
    expect(p.escalation.thrashDetection).toBe(true); // preserved from default
    expect(p.pattern).toBe("pev");                    // preserved from default
    expect(p.verificationStack).toEqual(["tests"]);   // preserved from default
  });

  test("resolveLoopPolicy handles null/undefined partial gracefully", () => {
    const a = resolveLoopPolicy(true, null);
    const b = resolveLoopPolicy(true, undefined);
    expect(a.pattern).toBe("pev");
    expect(b.pattern).toBe("pev");
  });

  test("resolveLoopPolicy full override — verificationStack replaces (not merges)", () => {
    const p = resolveLoopPolicy(true, { verificationStack: ["tests", "typecheck", "build"] });
    expect(p.verificationStack).toEqual(["tests", "typecheck", "build"]);
  });

  test("parseLoopPolicy round-trips valid JSON, tolerates junk", () => {
    expect(parseLoopPolicy(`{"pattern":"retry"}`)).toEqual({ pattern: "retry" });
    expect(parseLoopPolicy("not json")).toBeNull();
    expect(parseLoopPolicy(null)).toBeNull();
    expect(parseLoopPolicy("")).toBeNull();
  });
});
