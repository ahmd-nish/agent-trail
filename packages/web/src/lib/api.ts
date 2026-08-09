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
  | { type: "tool_call"; tool: string; toolUseId?: string; input?: string }
  | { type: "text"; text: string }
  | { type: "tool_result"; isError: boolean; toolUseId?: string; content?: string }
  | { type: "execution_complete"; status: "completed" | "failed"; executionId: string }
  | { type: "awaiting_human"; executionId: string }
  | { type: "test_result"; passed: boolean; exitCode: number; output: string };

export function streamTaskEvents(taskId: string, onEvent: (e: UiEvent) => void): () => void {
  // Demo mode intercept: if the demo player is active, route events through it
  // instead of opening a real SSE connection. Set up by App.tsx when ?demo=1.
  const demoSub = (window as unknown as { __atDemoSubscribe?: (id: string, cb: (e: UiEvent) => void) => (() => void) }).__atDemoSubscribe;
  if (demoSub) return demoSub(taskId, onEvent);

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
    update: (boardId: string, data: {
      webhookUrl?: string | null;
      defaultModel?: string | null;
      defaultAssignee?: string;
      defaultReviewKind?: string;
      permissionMode?: string;
      implementationDir?: string | null;
    }) =>
      req<Board>(`/api/boards/${boardId}`, { method: "PATCH", body: JSON.stringify(data) }),
    run: (boardId: string) =>
      req<{ scheduledCount: number }>(`/api/boards/${boardId}/run`, { method: "POST" }),
    runScope: (boardId: string, type: "epic" | "sprint", name: string) =>
      req<RunScopeResult>(`/api/boards/${boardId}/run-scope`, {
        method: "POST",
        body: JSON.stringify({ type, name }),
      }),
    isRunning: (boardId: string) =>
      req<{ running: boolean; activeCount: number; queuedCount: number; maxConcurrent: number }>(
        `/api/boards/${boardId}/running`,
      ),
    plan: (opts: { prdText: string; name?: string; boardId?: string; dryRun?: boolean }) =>
      req<PlanResult>("/api/boards/plan", { method: "POST", body: JSON.stringify(opts) }),
    // §C plan-review approval gate.
    approve: (boardId: string) =>
      req<Board>(`/api/boards/${boardId}/approve`, { method: "POST" }),
    // Phase 3b: encrypted env vars for test-case substitution
    listEnv: (boardId: string, reveal = false) =>
      req<{ entries: BoardEnvEntry[]; revealed: boolean }>(
        `/api/boards/${boardId}/env${reveal ? "?reveal=1" : ""}`,
      ),
    setEnv: (boardId: string, entries: Array<{ key: string; value: string }>) =>
      req<{ ok: boolean; count?: number; errors?: string[] }>(
        `/api/boards/${boardId}/env`,
        { method: "PUT", body: JSON.stringify({ entries }) },
      ),
    deleteEnv: (boardId: string, key: string) =>
      req<{ ok: boolean }>(
        `/api/boards/${boardId}/env/${encodeURIComponent(key)}`,
        { method: "DELETE" },
      ),
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
    stop: (taskId: string) =>
      req<{ ok: true }>(`/api/tasks/${taskId}/stop`, { method: "POST" }),
    decisions: (taskId: string) => req<DecisionTicketRow[]>(`/api/tasks/${taskId}/decisions`),
    test: (taskId: string, opts?: { filter?: string }) =>
      req<TestRunResult>(`/api/tasks/${taskId}/test`, { method: "POST", body: JSON.stringify(opts ?? {}) }),
    apiRequest: (taskId: string, options: ApiRequestOptions) =>
      req<ApiResponse>(`/api/tasks/${taskId}/api-request`, { method: "POST", body: JSON.stringify(options) }),
    customRun: (taskId: string, opts: { command: string }) =>
      req<{ passed: boolean; exitCode: number; output: string; durationMs: number }>(`/api/tasks/${taskId}/custom-run`, { method: "POST", body: JSON.stringify(opts) }),
    discoverUrls: (taskId: string) =>
      req<{ suggestions: UrlSuggestion[] }>(`/api/tasks/${taskId}/discover-urls`),
    // Phase 3d: run history
    recordRun: (taskId: string, caseId: string, run: {
      passed: boolean;
      durationMs: number;
      attempts?: number;
      output?: string;
      assertions?: unknown;
      ranAt?: string;
    }) =>
      req<{ ok: boolean }>(
        `/api/tasks/${taskId}/test-cases/${encodeURIComponent(caseId)}/run`,
        { method: "POST", body: JSON.stringify(run) },
      ),
    trend: (taskId: string, caseId: string, days = 14) =>
      req<{ total: number; passed: number; trend: Array<{ date: string; passes: number; fails: number }> }>(
        `/api/tasks/${taskId}/test-runs?caseId=${encodeURIComponent(caseId)}&days=${days}`,
      ),
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
  executions: {
    list: (taskId: string) => req<ExecutionRow[]>(`/api/tasks/${taskId}/executions`),
  },
  metrics: {
    board: (boardId: string) => req<TaskMetricsRow[]>(`/api/boards/${boardId}/metrics`),
  },
  export: {
    board: (boardId: string) => req<Record<string, unknown>>(`/api/boards/${boardId}/export`),
  },
  examples: {
    list: () => req<ExampleFile[]>("/api/examples"),
    get: (name: string) => req<{ name: string; content: string }>(`/api/examples/${encodeURIComponent(name)}`),
  },
  agents: {
    list: () => req<AgentEntry[]>("/api/agents"),
    get: (name: string) => req<AgentEntry & { body: string }>(`/api/agents/${encodeURIComponent(name)}`),
  },
  ideas: {
    start: (idea: string, modelTier?: "haiku" | "sonnet" | "opus") =>
      req<IdeaState>("/api/ideas/start", {
        method: "POST",
        body: JSON.stringify({ idea, ...(modelTier ? { modelTier } : {}) }),
      }),
    get: (id: string) => req<IdeaState>(`/api/ideas/${id}`),
    answer: (id: string, key: string, value: string | string[], note?: string) =>
      req<IdeaState>(`/api/ideas/${id}/answer`, {
        method: "POST",
        body: JSON.stringify({ key, value, ...(note ? { note } : {}) }),
      }),
    synthesizePrd: (id: string, modelTier?: "haiku" | "sonnet" | "opus") =>
      req<IdeaState>(`/api/ideas/${id}/synthesize-prd`, {
        method: "POST",
        body: JSON.stringify(modelTier ? { modelTier } : {}),
      }),
    linkBoard: (id: string, boardId: string) =>
      req<IdeaState>(`/api/ideas/${id}/link-board`, {
        method: "POST",
        body: JSON.stringify({ boardId }),
      }),
  },
  dev: {
    status: (boardId: string) => req<DevServerStatus>(`/api/boards/${boardId}/dev/status`),
    detect: (boardId: string) => req<{ command: string | null; port: number | null }>(`/api/boards/${boardId}/dev/detect`),
    start: (boardId: string, body?: { command?: string; port?: number | null }) =>
      req<DevServerStatus>(`/api/boards/${boardId}/dev/start`, { method: "POST", body: JSON.stringify(body ?? {}) }),
    stop: (boardId: string) =>
      req<{ ok: boolean; status: DevServerStatus }>(`/api/boards/${boardId}/dev/stop`, { method: "POST" }),
    logs: (boardId: string, limit = 100) =>
      req<DevLogLine[]>(`/api/boards/${boardId}/dev/logs?limit=${limit}`),
  },
};

export interface DevServerStatus {
  state: "running" | "stopped" | "starting" | "crashed";
  pid: number | null;
  port: number | null;
  command: string | null;
  cwd: string | null;
  uptimeMs: number | null;
  startedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  logsAvailable: number;
  /** True = TCP-connect to localhost:<port> succeeded.
   *  False = process up but port not bound (binding takes a moment, or wrong command).
   *  null  = no port or process not running. */
  portReachable: boolean | null;
}

export interface DevLogLine {
  ts: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface WizardOption {
  label: string;
  description?: string;
  pros: string[];
  cons: string[];
}

export interface WizardQuestion {
  key: string;
  question: string;
  description?: string;
  options: WizardOption[];
  multiSelect?: boolean;
  recommendedLabel?: string;
}

export interface WizardAnswer {
  value: string | string[];
  note?: string;
}

export interface IdeaState {
  id: string;
  boardId: string | null;
  ideaText: string;
  questions: WizardQuestion[];
  answers: Record<string, WizardAnswer>;
  synthesizedPrd: string | null;
  status: "gathering" | "ready" | "done" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface ExampleFile {
  name: string;
  title: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface AgentEntry {
  name: string;
  description: string;
  tools: string[];
  source: "project" | "monorepo" | "bundled";
  path: string;
}

export interface BlockerInfo {
  taskId: string;
  taskTitle: string;
  blockedById: string;
  blockedByTitle: string;
  blockedByEpic: string | null;
  blockedBySprint: string | null;
  blockedByStatus: string;
}

export interface RunScopeResult {
  scheduledCount: number;
  blockers: BlockerInfo[];
}

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

export interface ExecutionRow {
  id: string;
  task_id: string;
  status: string;
  agent_kind: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  exit_code: number | null;
  error_message: string | null;
}

export interface TaskMetricsRow {
  task_id: string;
  title: string;
  epic: string | null;
  sprint: string | null;
  status: string;
  priority: string;
  total_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  execution_count: number;
}

export interface UrlSuggestion {
  url: string;
  label: string;
  source: string;
}

export interface BoardEnvEntry {
  key: string;
  /** Masked preview when `revealed=false`, plaintext when `revealed=true`. */
  value: string;
  /** True iff `value` is a mask, not the real secret. */
  masked: boolean;
  updatedAt: string;
}

export interface ApiRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Per-request timeout. Server clamps to [100, 120000] ms. Default 30000. */
  timeoutMs?: number;
}

export interface ApiResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  durationMs: number;
  error?: string;
  /** True when the request was killed by the configured timeout. */
  timedOut?: boolean;
}

export interface TestRunResult {
  passed: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
  runner: string;
  cwd: string;
  passCount: number;
  failCount: number;
  totalCount: number;
  /** Tests that actually executed (pass + fail). Excludes skipped. */
  executedCount: number;
  ranSomething: boolean;
  /** True when the task had no worktree_path and the runner fell back to inventarium's own repo root. */
  usedFallbackCwd?: boolean;
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
