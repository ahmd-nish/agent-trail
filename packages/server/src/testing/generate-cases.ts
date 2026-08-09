// PRD_TESTING T3.2 — on-demand agent-authored test cases.
//
// Given a task's title/description/criteria (and optional prior examples for
// T3.4 round-trip learning), calls the local claude CLI headless and returns
// a validated TestCase[]. The heuristic generator remains available as an
// offline fallback (T3.3).

import type { TestCase, Task, Assertion } from "../../../core/src/types/index.ts";

export interface GeneratorInput {
  task: Pick<Task, "title" | "description" | "successCriteria" | "component">;
  /** Prior <original, human-fix> pairs on this board for T3.4 learning.
   *  Injected as few-shot examples into the prompt. */
  examples?: Array<{ original: TestCase; fixed: TestCase; note?: string }>;
  /** Existing cases on this task, so the generator doesn't repeat them. */
  existing?: TestCase[];
  /** Base URL prefix — helps the generator write realistic `path` values. */
  baseUrl?: string;
}

export interface GeneratorRunner {
  /** Invoke the underlying LLM with a prompt; return the raw response. */
  run(prompt: string): Promise<string>;
}

export interface GenerationResult {
  cases: TestCase[];
  usage: { inputTokens: number; outputTokens: number };
  source: "agent" | "mock";
}

const MAX_RETRIES = 2;

export function buildCaseGenPrompt(input: GeneratorInput): string {
  const criteria = input.task.successCriteria
    .map((c, i) => `  [${i}] ${c}`).join("\n") || "  (no success criteria supplied)";
  const existing = (input.existing ?? [])
    .map((c) => `  - ${c.label} (${c.kind}${c.method ? ` ${c.method} ${c.path}` : ""})`).join("\n") || "  (none)";
  const examplesBlock = (input.examples ?? []).length > 0
    ? `\nPrior examples on this board — the "original" was the generator's guess, "fixed" is what the human corrected to. Learn from the pattern (schema, path shape, header keys) — do NOT copy these verbatim:\n${
        (input.examples ?? []).map((e, i) => `  #${i + 1}${e.note ? ` (${e.note})` : ""}\n    original: ${JSON.stringify(compactCase(e.original))}\n    fixed:    ${JSON.stringify(compactCase(e.fixed))}`).join("\n")
      }\n`
    : "";
  const baseUrlNote = input.baseUrl ? `\nBase URL for the target service: ${input.baseUrl}\n` : "";

  return `You are writing verification test cases for a coding task. Your output is fed directly into a server-side test executor — every case must be runnable without a human editing it.

Task title: ${input.task.title}
Description: ${input.task.description || "(none)"}
Component: ${input.task.component ?? "(not specified)"}
${baseUrlNote}
Success criteria to verify (0-indexed):
${criteria}

Existing test cases (do NOT duplicate these):
${existing}
${examplesBlock}
Output ONLY a valid JSON object — no markdown fences, no explanation:

{
  "cases": [
    {
      "criterionIndex": 0,
      "category": "happy",
      "label": "Short imperative label for the case",
      "kind": "api",
      "method": "POST",
      "path": "/notes",
      "headers": "Content-Type: application/json",
      "body": "{\\"title\\":\\"hello\\"}",
      "assertions": [
        { "kind": "status", "equals": 201 },
        { "kind": "json_path", "path": "$.id", "exists": true }
      ]
    }
  ]
}

Rules:
- Emit 2-5 cases per criterion. AT LEAST one \`happy\` case AND at least one \`negative\` case per criterion.
- Include an \`edge\` case whenever the criterion mentions a boundary (empty input, pagination, max length, unicode).
- Use \`error\` for expected server-side failures (auth, rate-limit, timeout, upstream 5xx).
- category MUST be one of: happy | edge | negative | error | boundary | perf.
- Prefer typed assertions: status / status_in / body_contains / json_path / response_time_ms.
- Use path/body/headers as literal strings — {{env.KEY}} placeholders are allowed for secrets that will be substituted server-side.
- For chained cases, set dependsOnCaseId to a prior case's label (server will resolve at run time).
- Never fabricate paths or fields that aren't in the description — if you don't know, skip the case rather than guess.
`;
}

interface RawGeneratedCase {
  criterionIndex?: number;
  category?: "happy" | "edge" | "negative" | "error" | "boundary" | "perf";
  label?: string;
  kind?: "api" | "shell";
  method?: string;
  path?: string;
  headers?: string;
  body?: string;
  command?: string;
  assertions?: Assertion[];
  dependsOnCaseId?: string;
  notes?: string;
}

export async function generateCasesWithAgent(
  input: GeneratorInput,
  runner: GeneratorRunner,
): Promise<GenerationResult> {
  const prompt = buildCaseGenPrompt(input);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let raw: string;
    try {
      raw = await runner.run(attempt === 0 ? prompt : `${prompt}\n\nA previous attempt failed with: ${lastError?.message}\nFix the JSON.`);
    } catch (err) {
      // Runner failure is fatal — not a schema issue, don't retry.
      throw err instanceof Error ? err : new Error(String(err));
    }

    let parsed: { cases?: RawGeneratedCase[] };
    try {
      parsed = extractJson(raw);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    const rawCases = Array.isArray(parsed.cases) ? parsed.cases : [];
    if (rawCases.length === 0) {
      lastError = new Error(`Generator returned no cases`);
      continue;
    }

    const coerced: TestCase[] = [];
    let validationError: Error | null = null;
    for (const c of rawCases) {
      if (!c.label || (c.kind ?? "api") === "api" && !c.path) {
        validationError = new Error(`case missing label or path: ${JSON.stringify(c).slice(0, 200)}`);
        break;
      }
      coerced.push({
        id: `case-${crypto.randomUUID()}`,
        criterionIndex: c.criterionIndex ?? 0,
        // Default missing category to `happy` (matches the TestCase.category doc);
        // planner + agent-generated cases are both encouraged to set it, but a
        // hand-written case that skips it should still work.
        category: c.category ?? "happy",
        label: c.label,
        kind: c.kind ?? "api",
        method: c.method,
        path: c.path,
        headers: c.headers,
        body: c.body,
        command: c.command,
        assertions: c.assertions,
        dependsOnCaseId: c.dependsOnCaseId,
        notes: c.notes,
      });
    }
    if (validationError) { lastError = validationError; continue; }

    return {
      cases: coerced,
      usage: { inputTokens: 0, outputTokens: 0 },
      source: process.env["INVENTARIUM_CASE_GEN_MOCK"] ? "mock" : "agent",
    };
  }
  throw lastError ?? new Error("Case generator failed after retries");
}

function extractJson(text: string): { cases?: RawGeneratedCase[] } {
  try {
    return JSON.parse(text) as { cases?: RawGeneratedCase[] };
  } catch { /* fall through */ }
  const fenced = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fenced?.[1]) return JSON.parse(fenced[1].trim()) as { cases?: RawGeneratedCase[] };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1)) as { cases?: RawGeneratedCase[] };
  throw new Error(`no JSON in generator response: ${text.slice(0, 200)}`);
}

// Trim a TestCase to just the fields useful for a few-shot example — no ids,
// no lastRun, no criterionIndex noise.
function compactCase(tc: TestCase): Partial<TestCase> {
  return {
    label: tc.label,
    kind: tc.kind,
    method: tc.method,
    path: tc.path,
    headers: tc.headers,
    body: tc.body,
    command: tc.command,
    assertions: tc.assertions,
  };
}

// Default runner — headless claude CLI, mockable via env for tests.
export function makeClaudeCaseGenRunner(): GeneratorRunner {
  return {
    run: async (prompt) => {
      const mock = process.env["INVENTARIUM_CASE_GEN_MOCK"];
      if (mock) {
        if (mock.startsWith("file:")) return await Bun.file(mock.slice(5)).text();
        void prompt;
        return mock;
      }
      if (!Bun.which("claude")) {
        throw new Error("claude CLI not found in PATH — install from https://claude.ai/download and run `claude login`");
      }
      const proc = Bun.spawn(
        ["claude", "-p", prompt, "--output-format", "json", "--no-session-persistence"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) throw new Error(`claude exited ${exitCode}`);
      try {
        const wrapper = JSON.parse(stdout) as { result?: string };
        if (typeof wrapper.result === "string") return wrapper.result;
      } catch { /* fall through */ }
      return stdout;
    },
  };
}
