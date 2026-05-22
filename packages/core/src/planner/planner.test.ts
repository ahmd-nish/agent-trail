import { describe, expect, it, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../types/index.ts";

// --- DAG tests (pure, no mocking needed) ---

import { buildDag, type DagResult } from "./dag.ts";

describe("buildDag", () => {
  const makeTask = (id: string, dependsOn: string[] = []): Task => ({
    id,
    boardId: "board-1",
    title: `Task ${id}`,
    description: "",
    status: "backlog",
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it("orders a linear chain correctly", () => {
    const tasks = [
      makeTask("c", ["b"]),
      makeTask("a"),
      makeTask("b", ["a"]),
    ];
    const result = buildDag(tasks);
    const ids = result.ordered.map((t) => t.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  it("assigns the same parallelGroup to independent tasks at the same level", () => {
    // a → {b, c} → d
    const tasks = [
      makeTask("a"),
      makeTask("b", ["a"]),
      makeTask("c", ["a"]),
      makeTask("d", ["b", "c"]),
    ];
    const result = buildDag(tasks);
    const b = result.ordered.find((t) => t.id === "b")!;
    const c = result.ordered.find((t) => t.id === "c")!;
    expect(b.parallelGroup).not.toBeNull();
    expect(b.parallelGroup).toBe(c.parallelGroup);
  });

  it("assigns different parallelGroups for non-parallel tasks", () => {
    const tasks = [makeTask("a"), makeTask("b", ["a"])];
    const result = buildDag(tasks);
    const a = result.ordered.find((t) => t.id === "a")!;
    const b = result.ordered.find((t) => t.id === "b")!;
    // a and b are sequential — different groups
    expect(a.parallelGroup).not.toBe(b.parallelGroup);
  });

  it("detects a cycle and throws", () => {
    const tasks = [makeTask("a", ["b"]), makeTask("b", ["a"])];
    expect(() => buildDag(tasks)).toThrow(/cycle/i);
  });

  it("throws on unknown dependsOn reference", () => {
    const tasks = [makeTask("a", ["nonexistent"])];
    expect(() => buildDag(tasks)).toThrow(/nonexistent/);
  });

  it("handles an empty list", () => {
    const result = buildDag([]);
    expect(result.ordered).toHaveLength(0);
    expect(result.parallelGroups.size).toBe(0);
  });

  it("assigns solo tasks their own parallelGroup", () => {
    const tasks = [makeTask("x")];
    const result = buildDag(tasks);
    expect(result.ordered[0]!.parallelGroup).not.toBeNull();
  });
});

// --- Planner tests (Anthropic SDK stubbed) ---

// We mock the Anthropic module before importing the planner.
const mockCreate = mock(async (_params: unknown) => ({
  stop_reason: "tool_use",
  content: [
    {
      type: "tool_use",
      id: "call_1",
      name: "create_task_graph",
      input: {
        tasks: [
          {
            id: "task-1",
            title: "Create SQLite schema",
            description: "Write the initial database schema",
            priority: "high",
            tddEnabled: true,
            mcps: [],
            skills: [],
            dependsOn: [],
          },
          {
            id: "task-2",
            title: "Build POST /shorten endpoint",
            description: "Implement URL shortening logic",
            priority: "high",
            tddEnabled: true,
            mcps: [],
            skills: [],
            dependsOn: ["task-1"],
          },
          {
            id: "task-3",
            title: "Build GET /r/:code redirect",
            description: "Implement redirect with click count increment",
            priority: "high",
            tddEnabled: true,
            mcps: [],
            skills: [],
            dependsOn: ["task-1"],
          },
        ],
      },
    },
  ],
  usage: { input_tokens: 100, output_tokens: 200 },
}));

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
  Anthropic: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { planFromPrd } from "./index.ts";

describe("planFromPrd", () => {
  const samplePrd = readFileSync(
    join(import.meta.dir, "../../../../examples/sample-prd.md"),
    "utf-8",
  );

  beforeEach(() => {
    mockCreate.mockClear();
  });

  it("returns tasks with all required fields", async () => {
    const result = await planFromPrd(samplePrd, "board-1");
    expect(result.tasks.length).toBeGreaterThan(0);
    for (const task of result.tasks) {
      expect(task.id).toBeString();
      expect(task.boardId).toBe("board-1");
      expect(task.title).toBeString();
      expect(task.status).toBe("backlog");
      expect(Array.isArray(task.dependsOn)).toBe(true);
    }
  });

  it("all dependsOn references resolve to real task IDs", async () => {
    const result = await planFromPrd(samplePrd, "board-1");
    const ids = new Set(result.tasks.map((t) => t.id));
    for (const task of result.tasks) {
      for (const dep of task.dependsOn) {
        expect(ids.has(dep)).toBe(true);
      }
    }
  });

  it("tasks are topologically ordered (dependsOn IDs appear earlier)", async () => {
    const result = await planFromPrd(samplePrd, "board-1");
    const seen = new Set<string>();
    for (const task of result.tasks) {
      for (const dep of task.dependsOn) {
        expect(seen.has(dep)).toBe(true);
      }
      seen.add(task.id);
    }
  });

  it("calls the Anthropic API exactly once on success", async () => {
    await planFromPrd(samplePrd, "board-1");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("retries up to 2 times on validation failure before throwing", async () => {
    mockCreate.mockImplementationOnce(async () => ({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "create_task_graph", input: { tasks: "not-an-array" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    mockCreate.mockImplementationOnce(async () => ({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "create_task_graph", input: { tasks: "not-an-array" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    mockCreate.mockImplementationOnce(async () => ({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "create_task_graph", input: { tasks: "not-an-array" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));

    await expect(planFromPrd(samplePrd, "board-1")).rejects.toThrow();
    // 1 initial + 2 retries = 3 total calls
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });
});
