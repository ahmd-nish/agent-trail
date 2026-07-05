import { describe, test, expect } from "bun:test";
import { validateCases } from "./validate-cases.ts";
import type { TestCase } from "../../../core/src/types/index.ts";

// PRD_TESTING T4.3 — env placeholder validation at save time.

function tc(id: string, over: Partial<TestCase> = {}): TestCase {
  return {
    id,
    criterionIndex: 0,
    label: id,
    kind: "api",
    method: "GET",
    path: "/foo",
    ...over,
  };
}

describe("validateCases (T4.3)", () => {
  test("unknown {{env.KEY}} in path is flagged", () => {
    const w = validateCases([tc("a", { path: "/{{env.FOO}}" })], new Set(["BAR"]));
    expect(w).toEqual([{ caseId: "a", field: "path", placeholder: "{{env.FOO}}", reason: "unknown_env_key" }]);
  });

  test("known env key produces no warning", () => {
    const w = validateCases([tc("a", { headers: "Authorization: Bearer {{env.TOKEN}}" })], new Set(["TOKEN"]));
    expect(w).toEqual([]);
  });

  test("secret. namespace is checked against the same env-key set", () => {
    const w = validateCases([tc("a", { body: `{"k":"{{secret.WHOOPS}}"}` })], new Set(["OTHER"]));
    expect(w.length).toBe(1);
    expect(w[0]!.placeholder).toBe("{{secret.WHOOPS}}");
  });

  test("body + path + headers all get scanned", () => {
    const cases = [tc("a", {
      path: "/{{env.A}}",
      body: `{{env.B}}`,
      headers: `X: {{env.C}}`,
    })];
    const w = validateCases(cases, new Set(["A"]));
    // Only B and C unknown.
    expect(new Set(w.map((x) => x.field)).size).toBe(2);
    expect(w.every((x) => x.reason === "unknown_env_key")).toBe(true);
  });

  test("non-env placeholders (prev, cases) are ignored", () => {
    const cases = [tc("a", { path: "/{{prev.id}}/x/{{cases.foo.bar}}" })];
    expect(validateCases(cases, new Set())).toEqual([]);
  });
});
