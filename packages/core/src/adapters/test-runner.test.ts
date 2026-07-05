/**
 * Regression tests for the test-runner output parser. The framework-specific
 * regexes are easy to break — these tests pin behaviour against real fixture
 * stdout from each runner.
 */

import { describe, expect, it } from "bun:test";
import { parseCounts } from "./test-runner.ts";

describe("parseCounts — bun runner", () => {
  it("parses canonical pass/fail/Ran-N line", () => {
    const out = `
 46 pass
 0 fail
 173 expect() calls
Ran 46 tests across 5 files. [99.00ms]
`;
    expect(parseCounts("bun", out)).toEqual({ pass: 46, fail: 0, total: 46 });
  });

  it("includes skipped tests in total via the Ran-N line (P1.1 regression)", () => {
    const out = `
 10 pass
 0 fail
 3 skip
Ran 13 tests across 1 file.
`;
    expect(parseCounts("bun", out)).toEqual({ pass: 10, fail: 0, total: 13 });
  });

  it("handles a suite of all-skipped tests (P1.1 regression)", () => {
    // All-skipped: total > 0 but pass + fail === 0. The runTests caller
    // computes executedCount = pass + fail = 0 and marks this NOT a real
    // pass even when the exit code is 0.
    const out = `
 0 pass
 5 skip
 0 fail
Ran 5 tests across 1 file.
`;
    const r = parseCounts("bun", out);
    expect(r).toEqual({ pass: 0, fail: 0, total: 5 });
    expect(r.pass + r.fail).toBe(0); // executedCount = 0 → ranSomething = false
  });
});

describe("parseCounts — pytest runner", () => {
  it("parses canonical summary wrapped in =====", () => {
    const out = `
tests/test_user.py::test_create PASSED                                   [ 50%]
tests/test_user.py::test_login FAILED                                    [100%]

===== 1 passed, 1 failed in 0.42s =====
`;
    expect(parseCounts("pytest", out)).toEqual({ pass: 1, fail: 1, total: 2 });
  });

  it("only counts the wrapped summary, not body mentions (P1.3 regression)", () => {
    // The bare /(\d+)\s+passed/ used to match anywhere — a traceback that
    // happened to mention "passed" would skew counts. After the anchored
    // fix, only the ===== ... ===== summary line counts.
    const hostile = `
tests/x.py::test_a PASSED  [50%]
tests/x.py::test_b FAILED  [100%]
___ assertion failed: expected 3 passed messages ___
___ but we only saw 1 ___

===== 1 passed, 1 failed in 0.05s =====
`;
    expect(parseCounts("pytest", hostile)).toEqual({ pass: 1, fail: 1, total: 2 });
  });

  it("counts skipped in total", () => {
    const out = `===== 3 passed, 1 skipped, 1 failed in 0.05s =====`;
    expect(parseCounts("pytest", out)).toEqual({ pass: 3, fail: 1, total: 5 });
  });

  it("returns zeros when no wrapped summary is present", () => {
    expect(parseCounts("pytest", "no summary here")).toEqual({ pass: 0, fail: 0, total: 0 });
  });
});

describe("parseCounts — jest runner", () => {
  it("parses the Tests: line", () => {
    const out = `Tests:       2 failed, 8 passed, 10 total`;
    expect(parseCounts("jest", out)).toEqual({ pass: 8, fail: 2, total: 10 });
  });

  it("handles a no-failure summary", () => {
    const out = `Tests:       8 passed, 8 total`;
    expect(parseCounts("jest", out)).toEqual({ pass: 8, fail: 0, total: 8 });
  });
});

describe("parseCounts — vitest runner", () => {
  it("parses pre-1.x format", () => {
    const out = `Tests  1 failed | 12 passed (13)`;
    expect(parseCounts("vitest", out)).toEqual({ pass: 12, fail: 1, total: 13 });
  });

  it("parses 1.x+ format with skipped segment", () => {
    const out = `Tests  1 failed | 2 skipped | 12 passed (15)`;
    expect(parseCounts("vitest", out)).toEqual({ pass: 12, fail: 1, total: 15 });
  });
});

describe("parseCounts — symbol fallback", () => {
  it("counts ✓ / ✗ markers when no summary line parses", () => {
    const out = `
✓ test one
✓ test two
✗ test three
`;
    // Pass "bun" so the bun branch runs first — it won't match, then the
    // symbol fallback kicks in.
    expect(parseCounts("bun", out)).toEqual({ pass: 2, fail: 1, total: 3 });
  });
});
