import { buildDag } from "./dag.ts";
import { runClaudePlanner } from "./runner.ts";
import type { Task, Priority, AgentKind, TddPhase } from "../types/index.ts";

interface RawTask {
  id: string;
  title: string;
  description: string;
  priority?: Priority;
  assignee?: AgentKind;
  tddEnabled?: boolean;
  mcps?: string[];
  skills?: string[];
  subagents?: string[];
  dependsOn?: string[];
}

const MAX_RETRIES = 2;

function buildPrompt(prdText: string, previousError?: string): string {
  const errorNote = previousError
    ? `\nA previous attempt failed: ${previousError}\nPlease fix the issue.\n`
    : "";

  return `You are a software project planner. Analyze the PRD and produce a task graph.
${errorNote}
Output ONLY a valid JSON object — no markdown fences, no explanation, no surrounding text:

{
  "tasks": [
    {
      "id": "unique-slug",
      "title": "Short task title",
      "description": "What to implement in this task",
      "priority": "low | medium | high | critical",
      "assignee": "claude-code",
      "tddEnabled": true,
      "mcps": [],
      "skills": [],
      "subagents": [],
      "dependsOn": ["id-of-prerequisite-task"]
    }
  ]
}

Rules:
- Each task is a single focused deliverable implementable in one session
- Use dependsOn only for genuine ordering constraints
- Tasks that can run in parallel must NOT have dependsOn between them
- tddEnabled: true for code tasks; false for docs/config/deploy tasks
- Prefer 4-12 tasks for a typical MVP feature

PRD:
${prdText}`;
}

function extractTaskGraph(text: string): { tasks: RawTask[] } {
  // Direct parse
  try {
    const parsed = JSON.parse(text) as { tasks?: RawTask[] };
    if (Array.isArray(parsed.tasks)) return parsed as { tasks: RawTask[] };
  } catch { /* fall through */ }

  // Strip markdown fences
  const fenced = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim()) as { tasks: RawTask[] };
  }

  // Find outermost { ... }
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

function coerceTask(raw: RawTask, boardId: string): Task {
  const now = new Date().toISOString();
  return {
    id: raw.id,
    boardId,
    title: raw.title,
    description: raw.description ?? "",
    status: "backlog",
    priority: raw.priority ?? "medium",
    assignee: raw.assignee ?? "claude-code",
    tddEnabled: raw.tddEnabled ?? true,
    tddPhase: (raw.tddEnabled ?? true) ? "write_tests" : ("implement_only" as TddPhase),
    mcps: raw.mcps ?? [],
    skills: raw.skills ?? [],
    subagents: raw.subagents ?? [],
    dependsOn: raw.dependsOn ?? [],
    parallelGroup: null,
    activeForm: null,
    worktreePath: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface PlanResult {
  tasks: Task[];
  usage: { inputTokens: number; outputTokens: number };
}

export async function planFromPrd(prdText: string, boardId: string): Promise<PlanResult> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const prompt = buildPrompt(prdText, lastError?.message);

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

    const coerced = rawTasks.map((t) => coerceTask(t, boardId));
    const { ordered } = buildDag(coerced);

    return { tasks: ordered, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  throw lastError ?? new Error("Planner failed after retries");
}
