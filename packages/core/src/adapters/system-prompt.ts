import type { Task, TddPhase } from "../types/index.ts";

// System-prompt assembly for the claude adapter. Extracted from claude-code.ts
// so unit tests can pin it without triggering the execution-manager test's
// mock.module for the whole adapter file.

const PHASE_INSTRUCTIONS: Record<TddPhase, string> = {
  write_tests: `PHASE: write_tests
Your ONLY job is to write failing tests that define the expected behaviour of this task.
Do NOT implement any production code yet — tests should fail because the implementation does not exist.
Use the project's existing test framework (bun:test if available).`,

  implement: `PHASE: implement
Tests have already been written. Write the minimum production code needed to make them pass.
Do NOT modify existing tests. Run tests after implementing to confirm they pass.`,

  verify_tests: `PHASE: verify_tests
Run the test suite and report results. Do NOT modify any code.
Return exit code 0 only if all tests pass.`,

  implement_only: `PHASE: implement_only
No TDD gate — implement the full solution as described.`,
};

export function buildSystemPrompt(task: Task, constitution?: string): string {
  const parts = [
    "You are Claude Code executing a task inside an agent-trail pipeline.",
    "",
    PHASE_INSTRUCTIONS[task.tddPhase],
  ];
  if (task.skills.length > 0) {
    parts.push(`\nSuggested skills: ${task.skills.join(", ")}`);
  }
  // PRD 3.4 — prepend the L0 constitution (CLAUDE.md + .agent-trail/context/*.md).
  // Placed AFTER the phase instructions so the phase discipline stays load-bearing;
  // the constitution is scaffolding the agent inherits, not a new instruction to
  // override the current phase.
  const constitutionText = constitution?.trim();
  if (constitutionText) {
    parts.push(
      "",
      "## Team constitution (project rulings + past decisions — inherit these)",
      "",
      constitutionText,
    );
  }
  return parts.join("\n");
}
