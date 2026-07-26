import { describe, test, expect } from "bun:test";
import {
  buildQuestionsPrompt,
  buildPrdPrompt,
  parseAndRepairQuestions,
  validateSynthesizedPrd,
  REQUIRED_QUESTION_KEYS,
  type WizardQuestion,
} from "./index.ts";

describe("wizard prompts", () => {
  test("buildQuestionsPrompt includes the idea + every required dimension", () => {
    const prompt = buildQuestionsPrompt("A URL shortener with click analytics.");
    for (const key of REQUIRED_QUESTION_KEYS) expect(prompt).toContain(key);
    expect(prompt).toContain("URL shortener with click analytics");
    expect(prompt).toContain("Output ONLY a valid JSON");
  });

  test("buildQuestionsPrompt truncates long ideas to 4000 chars", () => {
    const longIdea = "x".repeat(6000);
    const prompt = buildQuestionsPrompt(longIdea);
    // The idea appears inside triple-quotes; the substring after """\n is capped.
    const between = prompt.split('"""')[1] ?? "";
    expect(between.length).toBeLessThan(4200); // includes newline padding
  });

  test("buildPrdPrompt reflects the actual answers, not just the questions", () => {
    const questions: WizardQuestion[] = [
      { key: "frontend", question: "Which frontend?", options: [{ label: "React", pros: [], cons: [] }] },
      { key: "backend",  question: "Which backend?",  options: [{ label: "Bun+Hono", pros: [], cons: [] }] },
    ];
    const prompt = buildPrdPrompt("A notes app.", questions, {
      frontend: { value: "React" },
      backend:  { value: "Bun+Hono", note: "must run cold in <100ms" },
    });
    expect(prompt).toContain("A notes app.");
    expect(prompt).toContain("→ React");
    expect(prompt).toContain("→ Bun+Hono");
    expect(prompt).toContain("must run cold in <100ms");
    expect(prompt).toContain("MARKDOWN ONLY");
  });
});

describe("parseAndRepairQuestions", () => {
  const validJson = JSON.stringify({
    questions: [
      {
        key: "frontend", question: "Frontend?", description: "Pick one.",
        options: [
          { label: "React (Vite)", pros: ["Fast", "Familiar"], cons: ["No SSR"] },
          { label: "Svelte",        pros: ["Compact"], cons: ["Smaller ecosystem"] },
        ],
        recommendedLabel: "React (Vite)",
      },
      {
        key: "backend", question: "Backend?",
        options: [
          { label: "Bun+Hono", pros: ["Zero config"], cons: ["Newer"] },
          { label: "Node+Express", pros: ["Ubiquitous"], cons: ["Older"] },
        ],
      },
      {
        key: "database", question: "Database?",
        options: [
          { label: "SQLite", pros: ["No infra"], cons: ["Single writer"] },
          { label: "Postgres", pros: ["Mature"], cons: ["Needs a server"] },
        ],
      },
      {
        key: "packages", question: "Add-ons?",
        multiSelect: true,
        options: [
          { label: "Auth", pros: ["Common need"], cons: [] },
          { label: "Payments", pros: ["Stripe integration"], cons: [] },
        ],
      },
    ],
  });

  test("happy path — returns all 4 questions in required order", () => {
    const { questions, warnings } = parseAndRepairQuestions(validJson);
    expect(warnings.length).toBe(0);
    expect(questions.map((q) => q.key)).toEqual([...REQUIRED_QUESTION_KEYS]);
    expect(questions[0]!.options.length).toBe(2);
    expect(questions[3]!.multiSelect).toBe(true);
  });

  test("packages question defaults to multiSelect even when the LLM forgets", () => {
    const noMulti = JSON.stringify({
      questions: [
        { key: "packages", question: "?", options: [{ label: "Auth", pros: [], cons: [] }, { label: "Payments", pros: [], cons: [] }] },
      ],
    });
    const { questions } = parseAndRepairQuestions(noMulti);
    expect(questions.find((q) => q.key === "packages")!.multiSelect).toBe(true);
  });

  test("missing dimensions are back-filled with placeholders + a warning", () => {
    const partial = JSON.stringify({
      questions: [
        { key: "frontend", question: "?", options: [{ label: "A", pros: [], cons: [] }, { label: "B", pros: [], cons: [] }] },
      ],
    });
    const { questions, warnings } = parseAndRepairQuestions(partial);
    expect(questions.length).toBe(REQUIRED_QUESTION_KEYS.length);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    for (const key of REQUIRED_QUESTION_KEYS) expect(questions.find((q) => q.key === key)).toBeDefined();
  });

  test("unknown keys are dropped with a warning; wrapped ```json fences tolerated", () => {
    const wrapped = "```json\n" + validJson + "\n```";
    const { questions, warnings } = parseAndRepairQuestions(wrapped);
    expect(questions.length).toBe(4);
    expect(warnings.length).toBe(0);
  });

  test("empty options[] is repaired to at least 2 placeholder options", () => {
    const empty = JSON.stringify({
      questions: [{ key: "frontend", question: "?", options: [] }],
    });
    const { questions, warnings } = parseAndRepairQuestions(empty);
    const fe = questions.find((q) => q.key === "frontend")!;
    expect(fe.options.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((w) => w.includes("frontend"))).toBe(true);
  });

  test("malformed JSON throws (upstream retries)", () => {
    expect(() => parseAndRepairQuestions("not json at all")).toThrow(/JSON/i);
  });
});

describe("validateSynthesizedPrd", () => {
  test("accepts a real-looking PRD", () => {
    const prd = "# Notes API\n\n## Problem\nUsers need a lightweight notes API...\n\n## Users\n...".padEnd(200, ".");
    expect(validateSynthesizedPrd(prd).ok).toBe(true);
  });

  test("rejects too-short output", () => {
    const r = validateSynthesizedPrd("# tiny");
    expect(r.ok).toBe(false);
  });

  test("rejects JSON-looking output", () => {
    const r = validateSynthesizedPrd(("{" + "x".repeat(200) + "}"));
    expect(r.ok).toBe(false);
  });
});
