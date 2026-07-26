import { describe, test, expect } from "bun:test";
import { buildIterationMemory, renderIterationHistory } from "./iteration.ts";

describe("iteration memory — PRD §5.2", () => {
  test("buildIterationMemory extracts a typed exception first", () => {
    const m = buildIterationMemory({
      taskTitle: "Add /notes",
      iteration: 2,
      testOutput: "some log\nTypeError: cannot read property 'x' of undefined\n  at notes.test.ts:10\n",
      gitDiff: "diff --git a/src/notes.ts b/src/notes.ts\n@@\n+bad code\n",
      exitCode: 1,
    });
    expect(m.summary).toContain("Iteration 2");
    expect(m.summary).toContain("Add /notes");
    expect(m.summary).toContain("TypeError");
    expect(m.summary).toContain("1 file(s) changed");
    expect(m.testOutputTail).toContain("TypeError");
  });

  test("falls back to FAIL line, then to first line", () => {
    const withFail = buildIterationMemory({
      taskTitle: "T", iteration: 1,
      testOutput: "boot\nsomething\nFAIL notes.test.ts\n", exitCode: 1,
    });
    expect(withFail.summary).toContain("FAIL notes.test.ts");

    const plain = buildIterationMemory({
      taskTitle: "T", iteration: 1,
      testOutput: "first line only\n", exitCode: 1,
    });
    expect(plain.summary).toContain("first line only");
  });

  test("tail / head are size-capped", () => {
    const big = "x".repeat(5000);
    const m = buildIterationMemory({
      taskTitle: "T", iteration: 1,
      testOutput: big, gitDiff: big,
    });
    expect(m.testOutputTail!.length).toBeLessThanOrEqual(801);   // 800 + ellipsis
    expect(m.gitDiffHead!.length).toBeLessThanOrEqual(401);
  });

  test("renderIterationHistory returns empty string for no samples", () => {
    expect(renderIterationHistory([])).toBe("");
  });

  test("renderIterationHistory sorts oldest → newest and includes both tails", () => {
    const s = renderIterationHistory([
      { iteration: 2, summary: "second", testOutputTail: "err B", gitDiffHead: "diff B" },
      { iteration: 1, summary: "first",  testOutputTail: "err A", gitDiffHead: "diff A" },
    ]);
    expect(s).toContain("Prior iterations (Ralph memory)");
    // Iter 1 must appear before Iter 2 in the rendered pack.
    expect(s.indexOf("Iter 1:")).toBeLessThan(s.indexOf("Iter 2:"));
    expect(s).toContain("err A");
    expect(s).toContain("err B");
  });

  test("summary always warns against repeating the same fix", () => {
    const m = buildIterationMemory({
      taskTitle: "T", iteration: 1,
      testOutput: null, gitDiff: null,
    });
    expect(m.summary).toContain("Do not repeat");
  });
});
