export type TaskStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done";

export type Priority = "low" | "medium" | "high" | "critical";

export type AgentKind = "claude-code" | "codex" | "gemini" | "custom";

export type TddPhase = "write_tests" | "implement" | "verify_tests" | "implement_only";

export type ExecutionStatus =
  | "pending"
  | "running"
  | "awaiting_human"
  | "completed"
  | "failed";

export type TelemetryEventKind =
  | "tool_call"
  | "tool_result"
  | "text"
  | "thinking"
  | "error"
  | "system";

export interface Board {
  id: string;
  name: string;
  prdSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  boardId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assignee: AgentKind;
  tddEnabled: boolean;
  tddPhase: TddPhase;
  mcps: string[];
  skills: string[];
  subagents: string[];
  dependsOn: string[];
  parallelGroup: string | null;
  activeForm: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Execution {
  id: string;
  taskId: string;
  status: ExecutionStatus;
  agentKind: AgentKind;
  tddPhase: TddPhase;
  mcpConfigPath: string | null;
  worktreePath: string | null;
  systemPrompt: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  exitCode: number | null;
  errorMessage: string | null;
}

export interface TelemetryEvent {
  id: string;
  executionId: string;
  taskId: string;
  seqNum: number;
  kind: TelemetryEventKind;
  toolName: string | null;
  toolInput: string | null;
  toolResult: string | null;
  textContent: string | null;
  rawJson: string;
  recordedAt: string;
}

export interface Artifact {
  id: string;
  taskId: string;
  executionId: string;
  kind: "git_diff" | "test_output" | "file_list" | "pr_url" | "custom";
  content: string;
  createdAt: string;
}

export interface DecisionTicket {
  id: string;
  taskId: string;
  executionId: string;
  question: string;
  context: string | null;
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
}
