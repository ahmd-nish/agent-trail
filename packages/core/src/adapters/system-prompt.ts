import type { Task, TddPhase } from "../types/index.ts";
import { assemblePrompt } from "../knowledge/bands.ts";

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

/** knowledgelayer §4.4 Band A — identical for every task in every project.
 *  Nothing task-derived may ever enter this string. */
export const ORG_PREAMBLE = "You are Claude Code executing a task inside an inventarium pipeline.";

/**
 * Legacy single-blob entry point, kept so callers that have not moved to bands
 * still work. It now assembles in §4.4 band order.
 *
 * The old order was: preamble, PHASE INSTRUCTIONS, skills, constitution — which
 * put per-task content at position 2 and truncated the common prefix between
 * any two spawns to a single line. Everything after it was unreusable no matter
 * how the CLI set its cache breakpoints. Phase discipline now sits in Band C,
 * after the stable prefix.
 *
 * Phase discipline stays load-bearing by being LAST rather than second: the
 * closest instruction to the task wins on recency, and it is no longer wedged
 * into the middle of the cacheable region.
 */
export function buildSystemPrompt(task: Task, constitution?: string): string {
  return buildBandedSystemPrompt(task, { org: ORG_PREAMBLE, project: constitution?.trim() ?? "" });
}

export interface SystemPromptBands {
  /** Band A — org-stable. Defaults to ORG_PREAMBLE. */
  org?: string;
  /** Band B — project-stable: constitution, PROJECT_MAP, module brief. */
  project?: string;
  /** Band C extras — per-spawn context assembled by the caller. */
  task?: string;
  /** Band D — governance warnings. */
  governance?: string;
}

/**
 * Band-aware assembly. Bands A and B must be byte-identical across every spawn
 * in a project; C and D are expected to vary.
 */
export function buildBandedSystemPrompt(task: Task, bands: SystemPromptBands = {}): string {
  const org = (bands.org ?? ORG_PREAMBLE).trim();

  const projectParts: string[] = [];
  const projectText = bands.project?.trim();
  if (projectText) {
    projectParts.push(
      "## Team constitution (project rulings + past decisions — inherit these)",
      "",
      projectText,
    );
  }

  // ── Band C — everything that varies per spawn ────────────────────────────
  const taskParts: string[] = [];
  const taskText = bands.task?.trim();
  if (taskText) taskParts.push(taskText);
  taskParts.push(PHASE_INSTRUCTIONS[task.tddPhase]);
  if (task.skills.length > 0) taskParts.push(`Suggested skills: ${task.skills.join(", ")}`);

  return assemblePrompt({
    org,
    project: projectParts.join("\n"),
    task: taskParts.join("\n\n"),
    governance: bands.governance?.trim() ?? "",
  });
}
