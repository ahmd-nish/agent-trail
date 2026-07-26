import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "./system-prompt.ts";
import type { Task } from "../types/index.ts";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    boardId: "b-1",
    title: "test task",
    description: "",
    status: "in_progress",
    assignee: "claude",
    tddEnabled: false,
    tddPhase: "implement_only",
    successCriteria: [],
    guardrails: [],
    dependsOn: [],
    skills: [],
    mcps: [],
    additionalPrompt: null,
    model: null,
    modelTier: null,
    subagents: [],
    component: null,
    epic: null,
    sprint: null,
    priority: null,
    worktreePath: null,
    createdAt: "2026-07-25T00:00:00Z",
    updatedAt: "2026-07-25T00:00:00Z",
    lastError: null,
    activeForm: null,
    testCases: [],
    ...overrides,
  } as Task;
}

describe("buildSystemPrompt — PRD 3.4 constitution injection", () => {
  test("no constitution → phase instructions only", () => {
    const prompt = buildSystemPrompt(makeTask({ tddPhase: "implement_only" }));
    expect(prompt).toContain("You are Claude Code");
    expect(prompt).toContain("PHASE: implement_only");
    expect(prompt).not.toContain("Team constitution");
  });

  test("empty/whitespace constitution is a no-op", () => {
    const prompt = buildSystemPrompt(makeTask(), "   \n  \n");
    expect(prompt).not.toContain("Team constitution");
  });

  test("constitution appended after the phase section", () => {
    const prompt = buildSystemPrompt(
      makeTask({ tddPhase: "write_tests" }),
      "Use bun, never npm.\nAll new code in TypeScript.",
    );
    expect(prompt).toContain("PHASE: write_tests");
    expect(prompt).toContain("## Team constitution");
    expect(prompt).toContain("Use bun, never npm.");
    // Phase discipline must not be overridable by the constitution — it comes
    // before, so its instructions are read first.
    const idxPhase = prompt.indexOf("PHASE: write_tests");
    const idxConstitution = prompt.indexOf("## Team constitution");
    expect(idxPhase).toBeLessThan(idxConstitution);
  });

  test("skills line still appears when constitution is present", () => {
    const prompt = buildSystemPrompt(
      makeTask({ skills: ["test-writer", "tdd-implementer"] }),
      "Ship small PRs.",
    );
    expect(prompt).toContain("Suggested skills: test-writer, tdd-implementer");
    expect(prompt).toContain("Ship small PRs.");
  });
});
