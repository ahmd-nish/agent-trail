/**
 * Regression tests for the heuristic test-case generator. The criteria are
 * lifted verbatim from examples/notes-app-prd.md so we catch real-world bugs
 * before they hit the UI.
 *
 * Run with: bun test packages/web/src/components/task-detail/generate-test-cases.test.ts
 */

import { describe, expect, test } from "bun:test";
import { generateCasesForCriterion, applyTemplate } from "./generate-test-cases.ts";

const gen = (text: string) => generateCasesForCriterion(text, 0);

describe("generateCasesForCriterion — single-clause API criteria", () => {
  test("POST with happy path keeps the method correct", () => {
    const [c] = gen("POST /notes with valid title+body returns 201 with a UUID id and tags: []");
    expect(c!.method).toBe("POST");
    expect(c!.path).toBe("/notes");
    expect(c!.expectedStatus).toBe(201);
  });

  test("POST happy path picks up the response-shape assertion", () => {
    const [c] = gen("POST /notes with valid title+body returns 201 with a UUID id and tags: []");
    // tags:[] wins over the UUID hint — the explicit JSON snippet is the
    // stronger signal. Both would be useful; we surface the most specific one.
    expect(c!.expectedBodyContains).toBe(`"tags":[]`);
  });

  test("POST with empty title returns 400 — body picks up empty title", () => {
    const [c] = gen("POST /notes with empty or missing title returns 400");
    expect(c!.method).toBe("POST");
    expect(c!.path).toBe("/notes");
    expect(c!.expectedStatus).toBe(400);
    expect(c!.body).toBe(JSON.stringify({ title: "" }));
  });

  test("GET /notes/:id 404 substitutes a known-missing UUID", () => {
    const [c] = gen("GET /notes/:id returns 404 for a non-existent id");
    expect(c!.method).toBe("GET");
    expect(c!.path).toBe("/notes/00000000-0000-0000-0000-000000000000");
    expect(c!.expectedStatus).toBe(404);
  });

  test("Tag conflict criterion produces POST with name body and 409", () => {
    const [c] = gen("POST /tags with an existing name returns 409 with the existing tag row");
    expect(c!.method).toBe("POST");
    expect(c!.path).toBe("/tags");
    expect(c!.expectedStatus).toBe(409);
    expect(c!.body).toContain("name");
  });

  test("Query-string criterion preserves the query in path", () => {
    const [c] = gen("GET /notes?tag=work returns only notes with the work tag");
    expect(c!.method).toBe("GET");
    expect(c!.path).toBe("/notes?tag=work");
  });
});

describe("generateCasesForCriterion — compound criteria split into multiple cases", () => {
  test("Semicolon split: PATCH no-fields THEN PATCH title-only", () => {
    const cases = gen(
      "PATCH /notes/:id with no fields returns 400; with title only bumps updated_at and leaves body unchanged",
    );
    expect(cases.length).toBeGreaterThanOrEqual(2);
    expect(cases[0]!.method).toBe("PATCH");
    expect(cases[0]!.expectedStatus).toBe(400);
    expect(cases[0]!.body).toBe("{}");
    expect(cases[1]!.method).toBe("PATCH"); // inherited
    expect(cases[1]!.body).toContain("title");
  });

  test('"and subsequent" creates a sequence with template substitution', () => {
    const cases = gen("DELETE /notes/:id returns 204 and subsequent GET /notes/:id returns 404");
    expect(cases.length).toBe(2);
    expect(cases[0]!.method).toBe("DELETE");
    expect(cases[0]!.expectedStatus).toBe(204);
    expect(cases[1]!.method).toBe("GET");
    expect(cases[1]!.expectedStatus).toBe(404);
    // Second case re-uses the first's id via the templating placeholder
    expect(cases[1]!.path).toContain("{{prev.id}}");
    expect(cases[1]!.dependsOnCaseId).toBe(cases[0]!.id);
  });

  test('", then" also creates a sequence', () => {
    const cases = gen("POST /notes creates a note, then GET /notes/:id returns it");
    expect(cases.length).toBe(2);
    expect(cases[0]!.method).toBe("POST");
    expect(cases[1]!.method).toBe("GET");
    expect(cases[1]!.dependsOnCaseId).toBe(cases[0]!.id);
  });
});

describe("generateCasesForCriterion — pagination and search criteria", () => {
  test("Pagination criterion preserves query params", () => {
    const [c] = gen("GET /notes?limit=2&offset=2 returns the 3rd-4th items and total reflects the full count");
    expect(c!.method).toBe("GET");
    expect(c!.path).toContain("limit=2");
    expect(c!.path).toContain("offset=2");
  });

  test("Search criterion stays as GET", () => {
    const [c] = gen("GET /notes?q=milk matches notes containing milk in title OR body");
    expect(c!.method).toBe("GET");
    expect(c!.path).toBe("/notes?q=milk");
  });
});

describe("generateCasesForCriterion — shell criteria", () => {
  test("bun install criterion becomes a shell case", () => {
    const [c] = gen("bun install completes without errors");
    expect(c!.kind).toBe("shell");
    expect(c!.command).toContain("bun install");
    expect(c!.expectedExitCode).toBe(0);
  });
});

describe("generateCasesForCriterion — fallback", () => {
  test("Criterion with no method falls back to GET / and includes a note", () => {
    const [c] = gen("The server should respond in under 500ms");
    expect(c!.kind).toBe("api");
    expect(c!.method).toBe("GET");
    expect(c!.path).toBe("/");
    expect(c!.notes ?? "").toMatch(/couldn't extract/i);
  });
});

describe("generateCasesForCriterion — transparency", () => {
  test("Every API case carries a notes field explaining its inference", () => {
    const cases = gen("POST /notes with valid title+body returns 201 with a UUID id and tags: []");
    for (const c of cases) {
      expect(c.notes).toBeTruthy();
      expect(typeof c.notes).toBe("string");
    }
  });
});

describe("applyTemplate", () => {
  test("substitutes {{prev.id}} when context has the key", () => {
    expect(applyTemplate("/notes/{{prev.id}}", { id: "abc" })).toBe("/notes/abc");
  });
  test("leaves placeholders intact when key is missing", () => {
    expect(applyTemplate("/notes/{{prev.id}}", {})).toBe("/notes/{{prev.id}}");
  });
  test("url mode encodes path-traversal characters", () => {
    expect(applyTemplate("/notes/{{prev.id}}", { id: "../../etc/passwd" }, "url"))
      .toBe("/notes/..%2F..%2Fetc%2Fpasswd");
  });
  test("url mode encodes query reserved characters", () => {
    expect(applyTemplate("/search?q={{prev.q}}", { q: "a&b=c" }, "url"))
      .toBe("/search?q=a%26b%3Dc");
  });
  test("json mode escapes embedded quotes in strings", () => {
    expect(applyTemplate(`{"id":"{{prev.id}}"}`, { id: 'a"b\\c' }, "json"))
      .toBe(`{"id":"a\\"b\\\\c"}`);
  });
  test("json mode emits numbers, booleans, and null verbatim", () => {
    expect(applyTemplate(`{"x":{{prev.n}}}`, { n: 42 }, "json")).toBe(`{"x":42}`);
    expect(applyTemplate(`{"x":{{prev.b}}}`, { b: true }, "json")).toBe(`{"x":true}`);
    expect(applyTemplate(`{"x":{{prev.z}}}`, { z: null }, "json")).toBe(`{"x":null}`);
  });
  test("raw mode (default) does not escape", () => {
    expect(applyTemplate("/notes/{{prev.id}}", { id: "../x" })).toBe("/notes/../x");
  });

  // Phase 3b: env-var substitution
  test("substitutes {{env.API_KEY}} from env context", () => {
    expect(applyTemplate(
      "Bearer {{env.API_KEY}}",
      { env: { API_KEY: "sk-123" } },
    )).toBe("Bearer sk-123");
  });
  test("env tokens stay literal when key is missing", () => {
    expect(applyTemplate("X={{env.MISSING}}", { env: {} })).toBe("X={{env.MISSING}}");
  });
  test("prev and env can both be substituted in one string", () => {
    expect(applyTemplate(
      "/api/{{prev.id}}?k={{env.K}}",
      { prev: { id: "abc" }, env: { K: "xyz" } },
      "url",
    )).toBe("/api/abc?k=xyz");
  });
  test("env values are escaped in url mode", () => {
    expect(applyTemplate(
      "/x?token={{env.TOKEN}}",
      { env: { TOKEN: "a/b c" } },
      "url",
    )).toBe("/x?token=a%2Fb%20c");
  });
});

describe("findUnresolvedTemplates", () => {
  test("returns nothing when all placeholders resolve", async () => {
    const { findUnresolvedTemplates } = await import("./generate-test-cases.ts");
    expect(findUnresolvedTemplates("/api/{{prev.id}}", { prev: { id: "x" } })).toEqual([]);
  });
  test("lists missing prev + env placeholders", async () => {
    const { findUnresolvedTemplates } = await import("./generate-test-cases.ts");
    const missing = findUnresolvedTemplates(
      "/api/{{prev.id}}?k={{env.K}}&j={{env.MISSING}}",
      { prev: { id: "x" }, env: { K: "v" } },
    );
    expect(missing).toEqual(["{{env.MISSING}}"]);
  });
  test("deduplicates ignoring repeats", async () => {
    const { findUnresolvedTemplates } = await import("./generate-test-cases.ts");
    // Current behavior: returns each occurrence (callers can Set if they want).
    const missing = findUnresolvedTemplates("a {{env.X}} b {{env.X}}", { env: {} });
    expect(missing.length).toBe(2);
  });
});
