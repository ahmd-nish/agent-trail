import { buildDag } from "./dag.ts";
import { runClaudePlanner } from "./runner.ts";
import { suggestTier } from "./models.ts";
import type { Task, Priority, AgentKind, TddPhase, ReviewKind, Guardrail, ModelTier, TestCase } from "../types/index.ts";

interface RawTask {
  id: string;
  title: string;
  description: string;
  epic?: string;
  sprint?: string;
  component?: string;
  priority?: Priority;
  assignee?: AgentKind;
  reviewKind?: ReviewKind;
  tddEnabled?: boolean;
  mcps?: string[];
  skills?: string[];
  subagents?: string[];
  dependsOn?: string[];
  externalDependencies?: string[];
  successCriteria?: string[];
  guardrails?: Array<{ priority: number; instruction: string }>;
  modelTier?: ModelTier;
  // PRD_TESTING T3.1 — planner-authored typed test cases per criterion.
  testCases?: Array<Omit<TestCase, "id" | "lastRun"> & { id?: string }>;
}

export interface BoardDefaults {
  defaultModel?: string | null;
  defaultAssignee?: AgentKind;
  defaultReviewKind?: ReviewKind;
}

const MAX_RETRIES = 2;

function buildPrompt(prdText: string, defaults: BoardDefaults, previousError?: string): string {
  const errorNote = previousError
    ? `\nA previous attempt failed: ${previousError}\nPlease fix the issue.\n`
    : "";

  const assigneeHint = defaults.defaultAssignee ? `Default assignee: ${defaults.defaultAssignee}` : "";
  const reviewHint = defaults.defaultReviewKind ? `Default reviewKind: ${defaults.defaultReviewKind}` : "";

  return `You are a software project planner. Analyse the PRD and produce a complete task graph with epics, sprints, success criteria, and guardrails.
${errorNote}
Output ONLY a valid JSON object — no markdown fences, no explanation, no surrounding text:

{
  "tasks": [
    {
      "id": "unique-kebab-slug",
      "title": "Short task title",
      "description": "Detailed description of exactly what to implement",
      "epic": "Epic name (e.g. Auth, Dashboard, API)",
      "sprint": "Sprint 1",
      "component": "FileName or /api/route",
      "priority": "low | medium | high | critical",
      "assignee": "claude-code",
      "reviewKind": "none | automated | browser | human",
      "tddEnabled": true,
      "mcps": [],
      "skills": [],
      "subagents": [],
      "dependsOn": ["id-of-prerequisite-task"],
      "externalDependencies": ["e.g. Design mockup from Figma", "API key from vendor"],
      "successCriteria": [
        "Specific, testable criterion 1",
        "Specific, testable criterion 2"
      ],
      "guardrails": [
        { "priority": 2, "instruction": "Must not break existing tests" },
        { "priority": 1, "instruction": "Error messages must be user-friendly" }
      ],
      "modelTier": "sonnet",
      "testCases": [
        {
          "criterionIndex": 0,
          "label": "POST /notes returns 201 with the created id",
          "kind": "api",
          "method": "POST",
          "path": "/notes",
          "body": "{\"title\":\"hello\",\"body\":\"world\"}",
          "headers": "Content-Type: application/json",
          "assertions": [
            { "kind": "status", "equals": 201 },
            { "kind": "json_path", "path": "$.id", "exists": true }
          ]
        }
      ]
    }
  ]
}

Rules:
- Each task is a single focused deliverable implementable in one agent session
- successCriteria: 2-4 specific, testable statements per task (what the automated test will verify)
- guardrails: 1-3 hard constraints; higher priority number = more critical
- epic: group related tasks under a short named epic
- sprint: assign to Sprint 1, Sprint 2, … based on dependency order and priority
- reviewKind: "automated" for pure API/logic, "browser" for any UI, "human" for design/content, "none" otherwise
- component: the specific file, class, or route being built (e.g. UserService, /api/auth/login)
- tddEnabled: true for all code tasks; false for docs/config/infra
- externalDependencies: only list if the task genuinely blocks on something outside the codebase
- dependsOn: only for genuine ordering constraints; parallel tasks must NOT depend on each other
- modelTier: "haiku" for docs/config/rename, "sonnet" for code + tests (default), "opus" only for hard reasoning
- testCases (PRD_TESTING T3.1): 1-3 concrete API cases per task, one per criterion. Prefer typed assertions (status, json_path). Skip when the task is UI-only or infra-only.
- Prefer 4-12 tasks for a typical MVP feature
${assigneeHint}
${reviewHint}

PRD:
${prdText}`;
}

function extractTaskGraph(text: string): { tasks: RawTask[] } {
  try {
    const parsed = JSON.parse(text) as { tasks?: RawTask[] };
    if (Array.isArray(parsed.tasks)) return parsed as { tasks: RawTask[] };
  } catch { /* fall through */ }

  const fenced = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim()) as { tasks: RawTask[] };
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(text.slice(start, end + 1)) as { tasks: RawTask[] };
  }

  throw new Error(`No valid JSON task graph found in response: ${text.slice(0, 200)}`);
}

function validateRawTasks(tasks: RawTask[], attempt: number): void {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`[attempt ${attempt}] Planner returned empty task list`);
  }
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!t.id || !t.title) {
      throw new Error(`[attempt ${attempt}] Task missing required id or title`);
    }
    if (ids.has(t.id)) {
      throw new Error(`[attempt ${attempt}] Duplicate task id: ${t.id}`);
    }
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`[attempt ${attempt}] Task "${t.id}" depends on unknown id "${dep}"`);
      }
    }
  }
}

function coerceTask(raw: RawTask, boardId: string, defaults: BoardDefaults): Task {
  const now = new Date().toISOString();
  const tddEnabled = raw.tddEnabled ?? true;
  const reviewKind = raw.reviewKind ?? defaults.defaultReviewKind ?? "none";
  // Prefer the planner's own hint; otherwise heuristically infer from title +
  // description. Board's defaultModel (if set) still wins the concrete `model`
  // slot, keeping the escape hatch for users pinning an exact version.
  const modelTier: ModelTier = raw.modelTier ?? suggestTier({
    title: raw.title,
    description: raw.description,
    tddEnabled,
    reviewKind,
    component: raw.component ?? null,
  });
  return {
    id: raw.id,
    boardId,
    title: raw.title,
    description: raw.description ?? "",
    status: "backlog",
    priority: raw.priority ?? "medium",
    assignee: raw.assignee ?? defaults.defaultAssignee ?? "claude-code",
    tddEnabled,
    tddPhase: tddEnabled ? "write_tests" : ("implement_only" as TddPhase),
    mcps: raw.mcps ?? [],
    skills: raw.skills ?? [],
    subagents: raw.subagents ?? [],
    dependsOn: raw.dependsOn ?? [],
    parallelGroup: null,
    activeForm: null,
    worktreePath: null,
    successCriteria: raw.successCriteria ?? [],
    guardrails: (raw.guardrails ?? []) as Guardrail[],
    epic: raw.epic ?? null,
    sprint: raw.sprint ?? null,
    reviewKind,
    reviewer: null,
    additionalPrompt: null,
    model: defaults.defaultModel ?? null,
    modelTier,
    component: raw.component ?? null,
    externalDependencies: raw.externalDependencies ?? [],
    testCases: (raw.testCases ?? []).map((tc, i) => ({
      ...(tc as TestCase),
      id: tc.id ?? `case-${crypto.randomUUID()}`,
      criterionIndex: tc.criterionIndex ?? i,
      label: tc.label ?? `Case ${i + 1}`,
      kind: tc.kind ?? "api",
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export interface PlanResult {
  tasks: Task[];
  usage: { inputTokens: number; outputTokens: number };
}

export async function planFromPrd(
  prdText: string,
  boardId: string,
  defaults: BoardDefaults = {},
): Promise<PlanResult> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const prompt = buildPrompt(prdText, defaults, lastError?.message);

    let resultText: string;
    try {
      resultText = await runClaudePlanner(prompt);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    let rawTasks: RawTask[];
    try {
      const graph = extractTaskGraph(resultText);
      rawTasks = graph.tasks;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    try {
      validateRawTasks(rawTasks, attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    const coerced = rawTasks.map((t) => coerceTask(t, boardId, defaults));
    const { ordered } = buildDag(coerced);

    return { tasks: ordered, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  throw lastError ?? new Error("Planner failed after retries");
}
