import { describe, test, expect } from "bun:test";
import { detectThrash } from "./thrash.ts";

describe("detectThrash — PRD §5.3", () => {
  test("empty history → no thrash", () => {
    expect(detectThrash([]).thrash).toBe(false);
  });

  test("single failure → no thrash yet", () => {
    const v = detectThrash([
      { status: "failed", tddPhase: "verify_tests", errorMessage: "AssertionError x" },
    ]);
    expect(v.thrash).toBe(false);
  });

  test("two identical verify failures → thrash with repeated_failure signal", () => {
    const v = detectThrash([
      { status: "failed", tddPhase: "verify_tests", errorMessage: "AssertionError: expected 1 to be 2\nat notes.test.ts:5" },
      { status: "failed", tddPhase: "verify_tests", errorMessage: "AssertionError: expected 1 to be 2\nat notes.test.ts:5" },
    ]);
    expect(v.thrash).toBe(true);
    expect(v.signal).toBe("repeated_failure");
    expect(v.history?.length).toBeGreaterThanOrEqual(2);
    expect(v.reason).toContain("same error");
  });

  test("two verify failures with different errors → not thrash", () => {
    const v = detectThrash([
      { status: "failed", tddPhase: "verify_tests", errorMessage: "AssertionError A" },
      { status: "failed", tddPhase: "verify_tests", errorMessage: "TypeError B" },
    ]);
    expect(v.thrash).toBe(false);
  });

  test("path differences are normalized away — /tmp/xyz vs /tmp/abc is same", () => {
    const v = detectThrash([
      { status: "failed", tddPhase: "verify_tests", errorMessage: "AssertionError at /tmp/aaa/notes.test.ts:5" },
      { status: "failed", tddPhase: "verify_tests", errorMessage: "AssertionError at /tmp/bbb/notes.test.ts:5" },
    ]);
    expect(v.thrash).toBe(true);
  });

  test("two zero-change implement runs → thrash with no_file_changes signal", () => {
    const v = detectThrash([
      { status: "failed", tddPhase: "verify_tests", errorMessage: "assertion failure" },
      { status: "completed", tddPhase: "implement", errorMessage: null, gitDiffLength: 0 },
      { status: "completed", tddPhase: "implement", errorMessage: null, gitDiffLength: 0 },
    ]);
    expect(v.thrash).toBe(true);
    expect(v.signal).toBe("no_file_changes");
    expect(v.reason).toContain("no file changes");
  });

  test("implement runs with real diffs → not thrash on that signal", () => {
    const v = detectThrash([
      { status: "failed",    tddPhase: "verify_tests", errorMessage: "different every time A" },
      { status: "completed", tddPhase: "implement",    errorMessage: null, gitDiffLength: 2000 },
      { status: "completed", tddPhase: "implement",    errorMessage: null, gitDiffLength: 1500 },
    ]);
    expect(v.thrash).toBe(false);
  });

  test("null error messages don't trigger a false-positive on the identity check", () => {
    const v = detectThrash([
      { status: "failed", tddPhase: "verify_tests", errorMessage: null },
      { status: "failed", tddPhase: "verify_tests", errorMessage: null },
    ]);
    expect(v.thrash).toBe(false);
  });
});

describe("normalize ordering — the 1-in-4 thrash miss", () => {
  // Same failure, but the durations differ in CHARACTER COUNT. Slicing the
  // tail before normalizing made these two compare unequal, so a genuinely
  // thrashing loop went undetected and kept burning tokens.
  const sample = (err: string) => ({ status: "failed", tddPhase: "verify_tests", errorMessage: err });
  const runA = `${"x".repeat(900)}\n1 | expect(1).toBe(2)\nRan 1 tests across 1 files. [12.34ms]`;
  const runB = `${"x".repeat(900)}\n1 | expect(1).toBe(2)\nRan 1 tests across 1 files. [9.1ms]`;

  test("identical failures with different-length durations are seen as identical", () => {
    const verdict = detectThrash([sample(runA), sample(runB)]);
    expect(verdict.thrash).toBe(true);
    expect(verdict.signal).toBe("repeated_failure");
  });

  test("ANSI colour codes do not defeat the comparison", () => {
    const coloured = `${"x".repeat(900)}\n\u001B[31m1 | expect(1).toBe(2)\u001B[0m\nRan 1 tests across 1 files. [4ms]`;
    expect(detectThrash([sample(runA), sample(coloured)]).thrash).toBe(true);
  });

  test("genuinely different failures are still distinguished", () => {
    const other = `${"x".repeat(900)}\n1 | expect(somethingElse).toBeNull()\nRan 1 tests across 1 files. [9.1ms]`;
    expect(detectThrash([sample(runA), sample(other)]).thrash).toBe(false);
  });
});
