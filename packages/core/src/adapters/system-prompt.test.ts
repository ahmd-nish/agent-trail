import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, buildBandedSystemPrompt, ORG_PREAMBLE } from "./system-prompt.ts";
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

  test("§4.4 — the project constitution precedes the phase section", () => {
    // ORDER INVERTED DELIBERATELY (knowledgelayer §4.4). This test previously
    // asserted phase-before-constitution. That put per-task content at
    // position 2 of every prompt, so the common prefix between two spawns
    // ended after one line and nothing below it could ever be cache-reused.
    //
    // Phase discipline stays load-bearing by being LAST rather than second —
    // the closest instruction to the task wins on recency, and it is no longer
    // wedged into the middle of the cacheable region.
    const prompt = buildSystemPrompt(
      makeTask({ tddPhase: "write_tests" }),
      "Use bun, never npm.\nAll new code in TypeScript.",
    );
    expect(prompt).toContain("PHASE: write_tests");
    expect(prompt).toContain("## Team constitution");
    expect(prompt).toContain("Use bun, never npm.");
    const idxPhase = prompt.indexOf("PHASE: write_tests");
    const idxConstitution = prompt.indexOf("## Team constitution");
    expect(idxConstitution).toBeLessThan(idxPhase);
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

describe("§4.4 band stability — the property that makes caching possible", () => {
  const CONSTITUTION = "Use bun, never npm.\nAll new code in TypeScript.";

  test("two DIFFERENT tasks in the same project share a byte-identical stable prefix", () => {
    // This is the whole point of the band split. If this ever fails, prefix
    // caching is impossible regardless of who sets the breakpoints.
    const a = buildBandedSystemPrompt(
      makeTask({ id: "t-1", title: "add login", tddPhase: "write_tests", skills: ["auth"] }),
      { project: CONSTITUTION, task: "task A specifics", governance: "warning A" },
    );
    const b = buildBandedSystemPrompt(
      makeTask({ id: "t-2", title: "fix billing", tddPhase: "verify_tests", skills: ["stripe"] }),
      { project: CONSTITUTION, task: "task B specifics", governance: "" },
    );

    const prefix = `${ORG_PREAMBLE}\n\n## Team constitution (project rulings + past decisions — inherit these)\n\n${CONSTITUTION}`;
    expect(a.startsWith(prefix)).toBe(true);
    expect(b.startsWith(prefix)).toBe(true);
    // And the divergence begins only AFTER the stable region.
    expect(a.slice(0, prefix.length)).toBe(b.slice(0, prefix.length));
  });

  test("no task-derived value leaks into the stable prefix", () => {
    const prompt = buildBandedSystemPrompt(
      makeTask({ id: "t-secret", title: "UNIQUE_TITLE_MARKER", tddPhase: "implement", skills: ["SKILL_MARKER"] }),
      { project: CONSTITUTION, task: "TASK_BODY_MARKER" },
    );
    const prefixEnd = prompt.indexOf("TASK_BODY_MARKER");
    const stable = prompt.slice(0, prefixEnd);
    for (const marker of ["UNIQUE_TITLE_MARKER", "SKILL_MARKER", "PHASE: implement"]) {
      expect(stable).not.toContain(marker);
    }
  });

  test("governance is last so a warning is the final thing read", () => {
    const prompt = buildBandedSystemPrompt(makeTask(), {
      project: CONSTITUTION, task: "ctx", governance: "GOVERNANCE_TAIL",
    });
    expect(prompt.trimEnd().endsWith("GOVERNANCE_TAIL")).toBe(true);
  });

  test("an empty band vanishes rather than leaving an empty header", () => {
    // An empty section still costs tokens AND still differs between spawns.
    const prompt = buildBandedSystemPrompt(makeTask(), { project: "", task: "", governance: "" });
    expect(prompt).not.toContain("Team constitution");
    expect(prompt).not.toContain("\n\n\n");
  });
});
