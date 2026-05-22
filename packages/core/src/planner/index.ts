import Anthropic from "@anthropic-ai/sdk";
import { buildDag } from "./dag.ts";
import type { Task, Priority, AgentKind, TddPhase } from "../types/index.ts";

const MODEL = "claude-sonnet-4-6";
const MAX_RETRIES = 2;

// Raw task shape returned by the create_task_graph tool
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

const TOOL_SCHEMA: Anthropic.Tool = {
  name: "create_task_graph",
  description:
    "Output the complete task graph derived from the PRD. Every task must have a unique ID. " +
    "Use dependsOn to express ordering constraints. Tasks that can run in parallel should have no dependsOn relationship.",
  input_schema: {
    type: "object" as const,
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique slug, e.g. 'setup-db' or 'task-1'" },
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
            assignee: {
              type: "string",
              enum: ["claude-code", "codex", "gemini", "custom"],
              default: "claude-code",
            },
            tddEnabled: {
              type: "boolean",
              description: "false only for non-code tasks like docs or config",
              default: true,
            },
            mcps: { type: "array", items: { type: "string" }, description: "MCP server names to enable" },
            skills: { type: "array", items: { type: "string" }, description: "Claude Code skill names to suggest" },
            subagents: { type: "array", items: { type: "string" } },
            dependsOn: {
              type: "array",
              items: { type: "string" },
              description: "IDs of tasks that must complete before this one can start",
            },
          },
          required: ["id", "title", "description"],
        },
      },
    },
    required: ["tasks"],
  },
};

const SYSTEM_PROMPT = `You are a software project planner. Given a PRD, produce a complete, minimal task graph.
Rules:
- Every task maps to a concrete deliverable a developer can implement in a single focused session.
- Express dependencies accurately — use dependsOn only when there is a genuine ordering constraint.
- Tasks that can run in parallel MUST NOT have a dependsOn relationship between them.
- Default tddEnabled to true for all code tasks. Set false only for docs, config, or deploy tasks.
- Prefer 4–12 tasks for a typical MVP feature. Fewer is better.`;

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

function extractTasks(response: Anthropic.Message): RawTask[] | null {
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "create_task_graph") {
      const input = block.input as Record<string, unknown>;
      const tasks = input["tasks"];
      if (Array.isArray(tasks)) return tasks as RawTask[];
    }
  }
  return null;
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
  // validate dependsOn references
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`[attempt ${attempt}] Task "${t.id}" depends on unknown id "${dep}"`);
      }
    }
  }
}

export interface PlanResult {
  tasks: Task[];
  usage: { inputTokens: number; outputTokens: number };
}

export async function planFromPrd(prdText: string, boardId: string): Promise<PlanResult> {
  const client = new Anthropic();

  let lastError: Error | null = null;
  let totalInput = 0;
  let totalOutput = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: `Please create a task graph for the following PRD:\n\n${prdText}` },
    ];

    if (attempt > 0 && lastError) {
      messages.push({
        role: "assistant",
        content: `I encountered a validation error. Let me try again.`,
      });
      messages.push({
        role: "user",
        content: `The previous attempt failed validation: ${lastError.message}. Please fix the task graph and call create_task_graph again.`,
      });
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [TOOL_SCHEMA],
      tool_choice: { type: "tool", name: "create_task_graph" },
      messages,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    const rawTasks = extractTasks(response);

    if (!rawTasks) {
      lastError = new Error(`[attempt ${attempt}] No create_task_graph tool call in response`);
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

    return {
      tasks: ordered,
      usage: { inputTokens: totalInput, outputTokens: totalOutput },
    };
  }

  throw lastError ?? new Error("Planner failed after retries");
}
