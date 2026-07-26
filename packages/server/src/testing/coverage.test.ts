import { describe, test, expect } from "bun:test";
import { computeCoverage } from "./coverage.ts";
import type { TestCase } from "../../../core/src/types/index.ts";

function mkCase(overrides: Partial<TestCase>): TestCase {
  return {
    id: `case-${Math.random()}`,
    criterionIndex: 0,
    label: "case",
    kind: "api",
    ...overrides,
  } as TestCase;
}

describe("coverage — PRD §B taxonomy audit", () => {
  test("meets the bar when a criterion has both happy + negative", () => {
    const report = computeCoverage("t-1", "Task", ["A"], [
      mkCase({ criterionIndex: 0, category: "happy" }),
      mkCase({ criterionIndex: 0, category: "negative" }),
    ]);
    expect(report.criteria[0]!.meetsBar).toBe(true);
    expect(report.criteria[0]!.missing).toEqual([]);
    expect(report.overall.criteriaMeetingBar).toBe(1);
  });

  test("missing negative → does not meet bar; suggestion includes 'negative'", () => {
    const report = computeCoverage("t-1", "Task", ["A"], [
      mkCase({ criterionIndex: 0, category: "happy" }),
      mkCase({ criterionIndex: 0, category: "happy" }),
    ]);
    expect(report.criteria[0]!.meetsBar).toBe(false);
    expect(report.criteria[0]!.missing).toEqual(["negative"]);
  });

  test("no cases at all → both happy AND negative flagged missing", () => {
    const report = computeCoverage("t-1", "Task", ["A"], []);
    expect(report.criteria[0]!.missing).toEqual(["happy", "negative"]);
  });

  test("cases without category are treated as happy (backward compat)", () => {
    const report = computeCoverage("t-1", "Task", ["A"], [
      mkCase({ criterionIndex: 0 }),                     // implicit happy
      mkCase({ criterionIndex: 0, category: "negative" }),
    ]);
    expect(report.criteria[0]!.meetsBar).toBe(true);
    expect(report.criteria[0]!.countByCategory.happy).toBe(1);
  });

  test("multiple criteria — bar computed per-criterion", () => {
    const report = computeCoverage("t-1", "Task", ["A", "B"], [
      mkCase({ criterionIndex: 0, category: "happy" }),
      mkCase({ criterionIndex: 0, category: "negative" }),
      mkCase({ criterionIndex: 1, category: "happy" }),
    ]);
    expect(report.criteria[0]!.meetsBar).toBe(true);
    expect(report.criteria[1]!.meetsBar).toBe(false);
    expect(report.overall.criteriaMeetingBar).toBe(1);
    expect(report.overall.totalCriteria).toBe(2);
  });

  test("overall.categoriesPresent lists categories in canonical order", () => {
    const report = computeCoverage("t-1", "Task", ["A"], [
      mkCase({ category: "edge" }),
      mkCase({ category: "happy" }),
      mkCase({ category: "negative" }),
    ]);
    expect(report.overall.categoriesPresent).toEqual(["happy", "negative", "edge"]);
  });
});
