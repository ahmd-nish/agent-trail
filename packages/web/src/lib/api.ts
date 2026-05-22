import type { Board, Task } from "../../../core/src/types/index.ts";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status} ${path}: ${err}`);
  }
  return res.json() as Promise<T>;
}

export type UiEvent =
  | { type: "connected"; executionId: string }
  | { type: "idle" }
  | { type: "tool_call"; tool: string }
  | { type: "text"; text: string }
  | { type: "tool_result"; isError: boolean }
  | { type: "execution_complete"; status: "completed" | "failed"; executionId: string }
  | { type: "awaiting_human"; executionId: string }
  | { type: "test_result"; passed: boolean; exitCode: number; output: string };

export function streamTaskEvents(taskId: string, onEvent: (e: UiEvent) => void): () => void {
  const es = new EventSource(`/api/tasks/${taskId}/stream`);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data as string) as UiEvent);
    } catch { /* ignore */ }
  };
  return () => es.close();
}

export const api = {
  boards: {
    list: () => req<Board[]>("/api/boards"),
    create: (name: string) => req<Board>("/api/boards", { method: "POST", body: JSON.stringify({ name }) }),
    delete: (boardId: string) => req<{ ok: boolean }>(`/api/boards/${boardId}`, { method: "DELETE" }),
    plan: (opts: { prdText: string; name?: string; boardId?: string; dryRun?: boolean }) =>
      req<PlanResult>("/api/boards/plan", { method: "POST", body: JSON.stringify(opts) }),
  },
  tasks: {
    list: (boardId: string) => req<Task[]>(`/api/boards/${boardId}/tasks`),
    create: (boardId: string, data: Partial<Task>) =>
      req<Task>(`/api/boards/${boardId}/tasks`, { method: "POST", body: JSON.stringify(data) }),
    update: (taskId: string, data: Partial<Task>) =>
      req<Task>(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (taskId: string) => req<{ ok: boolean }>(`/api/tasks/${taskId}`, { method: "DELETE" }),
    execute: (taskId: string) =>
      req<{ executionId: string }>(`/api/tasks/${taskId}/execute`, { method: "POST" }),
    decisions: (taskId: string) => req<DecisionTicketRow[]>(`/api/tasks/${taskId}/decisions`),
  },
  decisions: {
    answer: (ticketId: string, answer: string) =>
      req<{ ok: boolean; executionId: string }>(`/api/decisions/${ticketId}/answer`, {
        method: "POST",
        body: JSON.stringify({ answer }),
      }),
  },
  artifacts: {
    list: (taskId: string) => req<ArtifactRow[]>(`/api/tasks/${taskId}/artifacts`),
  },
  export: {
    board: (boardId: string) => req<Record<string, unknown>>(`/api/boards/${boardId}/export`),
  },
};

export interface PlanResult {
  board: { id: string; name: string } | null;
  tasks: Task[];
  usage: { inputTokens: number; outputTokens: number };
  dryRun: boolean;
}

export interface ArtifactRow {
  id: string;
  task_id: string;
  execution_id: string;
  kind: "git_diff" | "test_output" | "file_list" | "pr_url" | "custom";
  content: string;
  created_at: string;
}

export interface DecisionTicketRow {
  id: string;
  task_id: string;
  execution_id: string;
  question: string;
  context: string | null;
  answer: string | null;
  answered_at: string | null;
  created_at: string;
}
