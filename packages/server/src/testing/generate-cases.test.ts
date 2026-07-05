import { describe, test, expect } from "bun:test";
import { buildCaseGenPrompt, generateCasesWithAgent, type GeneratorRunner } from "./generate-cases.ts";
import type { TestCase } from "../../../core/src/types/index.ts";

// PRD_TESTING T3.2 + T3.4 unit tests.
// Prompt shape, JSON extraction, retry-on-invalid, few-shot injection.

const task = {
  title: "Notes API — create + read",
  description: "POST /notes accepts JSON body {title, body}; GET /notes lists all.",
  successCriteria: ["POST /notes returns 201 with id", "GET /notes returns array"],
  component: "notesRoute",
};

function fixedRunner(output: string): GeneratorRunner {
  return { run: async () => output };
}

describe("buildCaseGenPrompt", () => {
  test("mentions each success criterion with its index", () => {
    const p = buildCaseGenPrompt({ task });
    expect(p).toContain("[0] POST /notes returns 201 with id");
    expect(p).toContain("[1] GET /notes returns array");
  });

  test("lists existing cases so the generator doesn't duplicate", () => {
    const existing: TestCase[] = [
      { id: "x", criterionIndex: 0, label: "post creates", kind: "api", method: "POST", path: "/notes" },
    ];
    const p = buildCaseGenPrompt({ task, existing });
    expect(p).toContain("post creates (api POST /notes)");
  });

  test("T3.4 example block appears when examples supplied", () => {
    const original: TestCase = { id: "o", criterionIndex: 0, label: "wrong-guess", kind: "api", method: "POST", path: "/note" };
    const fixed:    TestCase = { id: "f", criterionIndex: 0, label: "wrong-guess", kind: "api", method: "POST", path: "/notes" };
    const p = buildCaseGenPrompt({
      task,
      examples: [{ original, fixed, note: "path was singular" }],
    });
    expect(p).toContain("Prior examples on this board");
    expect(p).toContain("path was singular");
    // Neither the original nor fixed IDs should appear — we compactCase() them.
    expect(p).not.toContain('"id":"o"');
    expect(p).not.toContain('"id":"f"');
  });

  test("baseUrl is included when supplied", () => {
    const p = buildCaseGenPrompt({ task, baseUrl: "http://localhost:5000" });
    expect(p).toContain("http://localhost:5000");
  });

  test("existing block reads '(none)' when nothing to skip", () => {
    const p = buildCaseGenPrompt({ task });
    expect(p).toContain("Existing test cases (do NOT duplicate these):\n  (none)");
  });
});

describe("generateCasesWithAgent", () => {
  const good = JSON.stringify({
    cases: [
      {
        criterionIndex: 0,
        label: "POST /notes → 201 + id",
        kind: "api",
        method: "POST",
        path: "/notes",
        headers: "Content-Type: application/json",
        body: `{"title":"t","body":"b"}`,
        assertions: [
          { kind: "status", equals: 201 },
          { kind: "json_path", path: "$.id", exists: true },
        ],
      },
      {
        criterionIndex: 1,
        label: "GET /notes → 200 array",
        kind: "api",
        method: "GET",
        path: "/notes",
        assertions: [{ kind: "status", equals: 200 }],
      },
    ],
  });

  test("happy path: two typed cases coerced with generated ids", async () => {
    const runner = fixedRunner(good);
    const result = await generateCasesWithAgent({ task }, runner);
    expect(result.cases.length).toBe(2);
    for (const c of result.cases) {
      expect(c.id).toMatch(/^case-/);
      expect(c.label).toBeTruthy();
    }
  });

  test("retries up to MAX_RETRIES on invalid JSON then throws", async () => {
    let calls = 0;
    const runner: GeneratorRunner = { run: async () => { calls++; return "not-json"; } };
    await expect(generateCasesWithAgent({ task }, runner)).rejects.toThrow();
    expect(calls).toBe(3); // initial + 2 retries
  });

  test("second attempt succeeds after a bad first attempt", async () => {
    let calls = 0;
    const runner: GeneratorRunner = {
      run: async () => {
        calls++;
        return calls === 1 ? "bogus" : good;
      },
    };
    const result = await generateCasesWithAgent({ task }, runner);
    expect(calls).toBe(2);
    expect(result.cases.length).toBe(2);
  });

  test("markdown-fenced JSON is unwrapped", async () => {
    const fenced = "```json\n" + good + "\n```";
    const result = await generateCasesWithAgent({ task }, fixedRunner(fenced));
    expect(result.cases.length).toBe(2);
  });

  test("case missing label + path is rejected as invalid", async () => {
    const bad = JSON.stringify({ cases: [{ criterionIndex: 0, kind: "api", method: "GET" }] });
    const runner: GeneratorRunner = { run: async () => bad };
    await expect(generateCasesWithAgent({ task }, runner)).rejects.toThrow(/missing label or path/);
  });
});
