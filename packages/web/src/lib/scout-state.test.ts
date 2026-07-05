import { describe, test, expect } from "bun:test";
import type { Task } from "../../../core/src/types/index.ts";
import { computeScoutState } from "./scout-state.ts";

let n = 0;
function T(over: Partial<Task> = {}): Task {
  return {
    id: over.id ?? `t${++n}`,
    boardId: "b1", title: "sample", description: "",
    status: "backlog", priority: "med", assignee: "claude-code",
    tddEnabled: false, tddPhase: null,
    mcps: [], skills: [], subagents: [], dependsOn: [], parallelGroup: null,
    activeForm: null, worktreePath: null, lastError: null,
    successCriteria: [], guardrails: [], epic: null, sprint: null,
    reviewKind: "none", reviewer: null, additionalPrompt: null,
    model: null, modelTier: null, component: null,
    externalDependencies: [], testCases: [],
    createdAt: "2026-07-05T00:00:00Z", updatedAt: "2026-07-05T00:00:00Z",
    ...over,
  };
}

describe("computeScoutState", () => {
  test("empty board", () => {
    const s = computeScoutState([], null);
    expect(s.total).toBe(0);
    expect(s.inProgress).toBe(0);
    expect(s.done).toBe(0);
    expect(s.running).toBeNull();
  });

  test("aggregates statuses across a real mix", () => {
    const tasks = [
      T({ id: "1", status: "in_progress", title: "auth", tddPhase: "verify_tests" }),
      T({ id: "2", status: "in_progress", title: "later" }),
      T({ id: "3", status: "done" }),
      T({ id: "4", status: "in_review" }),
      T({ id: "5", status: "blocked", activeForm: "answer needed" }),
      T({ id: "6", status: "blocked", lastError: "boom" }),
      T({ id: "7", status: "backlog" }),
    ];
    const s = computeScoutState(tasks, { activeCount: 2, queuedCount: 1, maxConcurrent: 3 });
    expect(s.total).toBe(7);
    expect(s.inProgress).toBe(2);
    expect(s.done).toBe(2);           // done + in_review
    expect(s.blocked).toBe(2);
    expect(s.decisionCount).toBe(1);  // only the one with activeForm
    expect(s.running?.id).toBe("1");  // first in_progress wins
    expect(s.runningPhase).toBe("verify_tests");
    expect(s.runStats?.activeCount).toBe(2);
  });

  test("runStats null passes through unchanged", () => {
    const s = computeScoutState([T({ status: "backlog" })], null);
    expect(s.runStats).toBeNull();
  });
});
