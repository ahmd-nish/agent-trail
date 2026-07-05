import { describe, test, expect } from "bun:test";
import { layoutDag } from "./dag-layout.ts";
import type { Task, TaskStatus } from "../../../core/src/types/index.ts";

// Pure DAG layout — PRD 1.3 DAG view.
// Every assertion here maps to a UI behavior:
//   • roots share level 0        → same left column in the graph
//   • diamonds join at max+1     → downstream tasks land past both parents
//   • cycles don't crash         → UI stays alive under bad planner output
//   • unknown deps are ignored   → orphan refs don't collapse the level

const t = (
  id: string,
  status: TaskStatus,
  dependsOn: string[] = [],
): Task => ({
  id,
  boardId: "b",
  title: id,
  description: "",
  status,
  priority: "medium",
  assignee: "claude-code",
  tddEnabled: true,
  tddPhase: "write_tests",
  mcps: [],
  skills: [],
  subagents: [],
  dependsOn,
  parallelGroup: null,
  activeForm: null,
  worktreePath: null,
  lastError: null,
  successCriteria: [],
  guardrails: [],
  epic: null,
  sprint: null,
  reviewKind: "none",
  reviewer: null,
  additionalPrompt: null,
  model: null,
  modelTier: null,
  component: null,
  externalDependencies: [],
  testCases: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
});

const levelOf = (
  nodes: { id: string; level: number }[],
  id: string,
): number => nodes.find((n) => n.id === id)!.level;

describe("layoutDag", () => {
  test("empty task list yields empty output", () => {
    const { nodes, edges } = layoutDag([]);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  test("roots share level 0", () => {
    const tasks = [t("a", "ready"), t("b", "ready"), t("c", "ready")];
    const { nodes } = layoutDag(tasks);
    for (const n of nodes) expect(n.level).toBe(0);
    // Their y positions should be different (stacked vertically).
    const ys = new Set(nodes.map((n) => n.y));
    expect(ys.size).toBe(3);
  });

  test("linear chain places tasks on consecutive levels", () => {
    const tasks = [
      t("a", "done"),
      t("b", "ready", ["a"]),
      t("c", "backlog", ["b"]),
    ];
    const { nodes, edges } = layoutDag(tasks);
    expect(levelOf(nodes, "a")).toBe(0);
    expect(levelOf(nodes, "b")).toBe(1);
    expect(levelOf(nodes, "c")).toBe(2);
    // Two edges, both non-active (nothing running).
    expect(edges.length).toBe(2);
    for (const e of edges) expect(e.active).toBe(false);
  });

  test("diamond: task joins at max(parents)+1", () => {
    //     a
    //    / \
    //   b   c
    //    \ /
    //     d
    const tasks = [
      t("a", "done"),
      t("b", "done", ["a"]),
      t("c", "done", ["a"]),
      t("d", "ready", ["b", "c"]),
    ];
    const { nodes } = layoutDag(tasks);
    expect(levelOf(nodes, "a")).toBe(0);
    expect(levelOf(nodes, "b")).toBe(1);
    expect(levelOf(nodes, "c")).toBe(1);
    expect(levelOf(nodes, "d")).toBe(2);
  });

  test("skip-level dependency picks the deeper parent", () => {
    // a → b → c   and   a → c  (c should still land at level 2, not level 1)
    const tasks = [
      t("a", "done"),
      t("b", "done", ["a"]),
      t("c", "ready", ["a", "b"]),
    ];
    const { nodes } = layoutDag(tasks);
    expect(levelOf(nodes, "c")).toBe(2);
  });

  test("cycles do not throw and every task gets a level", () => {
    // a → b → c → a (cycle)
    const tasks = [
      t("a", "ready", ["c"]),
      t("b", "ready", ["a"]),
      t("c", "ready", ["b"]),
    ];
    const { nodes } = layoutDag(tasks);
    expect(nodes.length).toBe(3);
    for (const n of nodes) expect(typeof n.level).toBe("number");
  });

  test("unknown dependency reference is tolerated (task treated as root)", () => {
    const tasks = [t("orphan", "ready", ["does-not-exist"])];
    const { nodes, edges } = layoutDag(tasks);
    expect(levelOf(nodes, "orphan")).toBe(0);
    // The edge is still emitted (renderer will show a dangling arrow if it
    // wants to visualise the broken ref).
    expect(edges).toContainEqual({
      id: "does-not-exist->orphan",
      source: "does-not-exist",
      target: "orphan",
      active: false,
    });
  });

  test("edges to in_progress tasks are marked active", () => {
    const tasks = [t("a", "done"), t("b", "in_progress", ["a"])];
    const { edges } = layoutDag(tasks);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.active).toBe(true);
  });

  test("respects custom hGap / vGap so callers can retune spacing", () => {
    const tasks = [
      t("a", "ready"),
      t("b", "ready"),
      t("c", "ready", ["a"]),
    ];
    const { nodes } = layoutDag(tasks, { hGap: 100, vGap: 10, nodeHeight: 40 });
    // c is at level 1 → x should be 100. Roots at level 0 → x = 0.
    expect(nodes.find((n) => n.id === "a")!.x).toBe(0);
    expect(nodes.find((n) => n.id === "c")!.x).toBe(100);
    // b (the second root) sits below a at y = 40 + 10 = 50.
    expect(nodes.find((n) => n.id === "b")!.y).toBe(50);
  });

  test("preserves original Task reference for each node", () => {
    const task = t("a", "in_progress");
    const { nodes } = layoutDag([task]);
    // A renderer needs the exact Task to render title / modelTier / etc.
    expect(nodes[0]!.task).toBe(task);
  });
});
