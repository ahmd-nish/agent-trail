import { describe, expect, it } from "bun:test";
import type { TestCase } from "../types/index.ts";
import { deriveAssertions, synthesizeFromLegacy, isLegacyCase } from "./legacy-assertions.ts";

const apiCase = (overrides: Partial<TestCase> = {}): TestCase => ({
  id: "c1",
  criterionIndex: 0,
  label: "x",
  kind: "api",
  ...overrides,
});

const shellCase = (overrides: Partial<TestCase> = {}): TestCase => ({
  id: "c2",
  criterionIndex: 0,
  label: "x",
  kind: "shell",
  ...overrides,
});

describe("deriveAssertions", () => {
  it("returns explicit assertions when present", () => {
    const tc = apiCase({
      assertions: [{ kind: "status", equals: 200 }],
      expectedStatus: 999, // should be ignored
    });
    expect(deriveAssertions(tc)).toEqual([{ kind: "status", equals: 200 }]);
  });

  it("synthesizes from legacy expectedStatus + expectedBodyContains", () => {
    const tc = apiCase({ expectedStatus: 201, expectedBodyContains: `"id":"` });
    expect(deriveAssertions(tc)).toEqual([
      { kind: "status", equals: 201 },
      { kind: "body_contains", text: `"id":"` },
    ]);
  });

  it("falls back to status only when no body assertion", () => {
    const tc = apiCase({ expectedStatus: 204 });
    expect(deriveAssertions(tc)).toEqual([{ kind: "status", equals: 204 }]);
  });

  it("synthesizes exit_code for shell cases", () => {
    expect(deriveAssertions(shellCase({ expectedExitCode: 0 }))).toEqual([
      { kind: "exit_code", equals: 0 },
    ]);
    expect(deriveAssertions(shellCase({ expectedExitCode: 1 }))).toEqual([
      { kind: "exit_code", equals: 1 },
    ]);
  });

  it("defaults shell expectedExitCode to 0 when missing", () => {
    expect(deriveAssertions(shellCase())).toEqual([{ kind: "exit_code", equals: 0 }]);
  });

  it("returns [] for api case with no assertions and no legacy fields", () => {
    expect(deriveAssertions(apiCase())).toEqual([]);
  });

  it("treats empty explicit assertions as missing — falls back to legacy", () => {
    const tc = apiCase({ assertions: [], expectedStatus: 200 });
    expect(deriveAssertions(tc)).toEqual([{ kind: "status", equals: 200 }]);
  });

  it("ignores empty-string expectedBodyContains", () => {
    const tc = apiCase({ expectedStatus: 200, expectedBodyContains: "" });
    expect(deriveAssertions(tc)).toEqual([{ kind: "status", equals: 200 }]);
  });
});

describe("isLegacyCase", () => {
  it("true when only legacy fields present", () => {
    expect(isLegacyCase(apiCase({ expectedStatus: 200 }))).toBe(true);
    expect(isLegacyCase(apiCase({ expectedBodyContains: "x" }))).toBe(true);
    expect(isLegacyCase(shellCase({ expectedExitCode: 0 }))).toBe(true);
  });

  it("false when explicit assertions present", () => {
    expect(isLegacyCase(apiCase({
      assertions: [{ kind: "status", equals: 200 }],
      expectedStatus: 200,
    }))).toBe(false);
  });

  it("false for an empty new case", () => {
    expect(isLegacyCase(apiCase())).toBe(false);
  });
});

describe("synthesizeFromLegacy", () => {
  it("returns [] when api case has no legacy fields", () => {
    expect(synthesizeFromLegacy(apiCase())).toEqual([]);
  });
});
