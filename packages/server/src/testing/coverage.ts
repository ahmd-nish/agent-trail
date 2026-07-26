import type { TestCase } from "../../../core/src/types/index.ts";

// PRD_OPEN_SOURCE §B — comprehensive test coverage.
//
// Given a task's success criteria and its test cases, tell the UI + CI which
// criteria are under-covered so agents (or humans) know what to add.
// Bar: every criterion needs BOTH a happy case AND a negative case; edge is
// a warning, not a hard failure.

export type Category = NonNullable<TestCase["category"]>;
export const CATEGORY_ORDER: Category[] = ["happy", "negative", "edge", "error", "boundary", "perf"];

export interface CriterionCoverage {
  criterionIndex: number;
  criterionLabel: string;
  countByCategory: Record<Category, number>;
  hasHappy: boolean;
  hasNegative: boolean;
  hasEdge: boolean;
  /** Coverage bar: happy + negative required. */
  meetsBar: boolean;
  /** Human-readable suggestions for what to add. */
  missing: Category[];
}

export interface CoverageReport {
  taskId: string;
  taskTitle: string;
  criteria: CriterionCoverage[];
  overall: {
    totalCriteria: number;
    criteriaMeetingBar: number;
    totalCases: number;
    categoriesPresent: Category[];
  };
}

export function computeCoverage(
  taskId: string,
  taskTitle: string,
  criteria: string[],
  cases: TestCase[],
): CoverageReport {
  const byCriterion = new Map<number, TestCase[]>();
  for (const c of cases) {
    const idx = Number.isFinite(c.criterionIndex) ? c.criterionIndex : 0;
    const list = byCriterion.get(idx) ?? [];
    list.push(c);
    byCriterion.set(idx, list);
  }

  const criteriaReport: CriterionCoverage[] = criteria.map((label, idx) => {
    const list = byCriterion.get(idx) ?? [];
    const countByCategory = emptyCounts();
    for (const c of list) {
      const cat = (c.category ?? "happy") as Category;
      countByCategory[cat] = (countByCategory[cat] ?? 0) + 1;
    }
    const hasHappy    = countByCategory.happy    > 0;
    const hasNegative = countByCategory.negative > 0;
    const hasEdge     = countByCategory.edge     > 0;
    const missing: Category[] = [];
    if (!hasHappy)    missing.push("happy");
    if (!hasNegative) missing.push("negative");
    return {
      criterionIndex: idx,
      criterionLabel: label,
      countByCategory,
      hasHappy,
      hasNegative,
      hasEdge,
      meetsBar: hasHappy && hasNegative,
      missing,
    };
  });

  const overallCategoriesSet = new Set<Category>();
  for (const c of cases) overallCategoriesSet.add((c.category ?? "happy") as Category);

  return {
    taskId,
    taskTitle,
    criteria: criteriaReport,
    overall: {
      totalCriteria: criteria.length,
      criteriaMeetingBar: criteriaReport.filter((c) => c.meetsBar).length,
      totalCases: cases.length,
      categoriesPresent: CATEGORY_ORDER.filter((c) => overallCategoriesSet.has(c)),
    },
  };
}

function emptyCounts(): Record<Category, number> {
  return { happy: 0, negative: 0, edge: 0, error: 0, boundary: 0, perf: 0 };
}
