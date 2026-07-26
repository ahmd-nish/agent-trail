export type TaskStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done";

export type ReviewKind = "automated" | "browser" | "human" | "none";

export interface Guardrail {
  priority: number;
  instruction: string;
}

export type Priority = "low" | "medium" | "high" | "critical";

/**
 * Static model router tier. Resolves to a concrete Claude model at spawn time.
 * See `models.ts` for tier → model-name mapping.
 *
 *   haiku  — fast, cheap, docs / config / trivial code
 *   sonnet — default for code + tests
 *   opus   — hard reasoning; escalated by v2 router (phase 4.5)
 */
export type ModelTier = "haiku" | "sonnet" | "opus";

export type AgentKind = "claude-code" | "codex" | "gemini" | "custom";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

/**
 * Single source of truth for the default permission mode applied when:
 *   - a board row has a NULL permission_mode (legacy pre-v0.1.1 DBs)
 *   - a board lookup misses entirely in the execution manager
 *   - a new board is inserted without an explicit override (routes/boards.ts)
 *
 * `acceptEdits` is safer for an OSS tool than `bypassPermissions` — the
 * agent still asks for irreversible actions, but routine edits flow through.
 * Matches the schema.sql default and the `boards.permission_mode` CHECK.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";

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
  webhookUrl: string | null;
  defaultModel: string | null;
  defaultAssignee: AgentKind;
  defaultReviewKind: ReviewKind;
  permissionMode: PermissionMode;
  /** Absolute path where Claude writes code for this board's tasks. Tests run here too. */
  implementationDir: string | null;
  /** Shell command to start the board's dev server (e.g. "bun run dev"). */
  devCommand: string | null;
  /** Port the dev server listens on — used for health checks and base-URL inference. */
  devPort: number | null;
  /** Hard ceiling on a single task's claude run. Defaults to 20 minutes. */
  executionTimeoutMs: number;
  /** PRD_OPEN_SOURCE 2.3 — trip at this many USD of estimated model spend
   *  during a single execution. 0 disables. */
  executionCostCapUsd: number;
  /** PRD_OPEN_SOURCE 2.3 — trip at this many input+output tokens during a
   *  single execution. 0 disables. */
  executionTokenCap: number;
  /** PRD_OPEN_SOURCE 2.5 — after a successful task, invoke the commit agent. */
  autoCommit: boolean;
  /** PRD_OPEN_SOURCE 2.6 — after a successful task + commit, push + open PR. */
  autoPr: boolean;
  /** "conventional" | "plain" — style of message the commit agent emits. */
  commitStyle: string;
  /** PRD_OPEN_SOURCE §C — plan-review gate. Null while the wizard/planner
   *  is still producing the graph AND while the human hasn't reviewed the
   *  plan; ISO date once approved. Execution is blocked while null. */
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Same default the schema applies, surfaced here for any code path that builds a Board without going through the DB (e.g. plan modal). */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 1_200_000;

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
  lastError: string | null;
  // v0.2 rich fields
  successCriteria: string[];
  guardrails: Guardrail[];
  epic: string | null;
  sprint: string | null;
  reviewKind: ReviewKind;
  reviewer: string | null;
  additionalPrompt: string | null;
  /** Explicit model name (e.g. "claude-sonnet-4-6") — overrides `modelTier`. */
  model: string | null;
  /** Static-router tier. Planner sets this; user can override on the card. */
  modelTier: ModelTier | null;
  component: string | null;
  externalDependencies: string[];
  testCases: TestCase[];
  /** PRD_OPEN_SOURCE §5.1 — loop-engineering policy. Null = use the
   *  tddEnabled-based defaults from `packages/core/src/loop/policy.ts`. */
  loopPolicy: unknown | null;
  /** PRD_OPEN_SOURCE §4.7 — repo paths this task is expected to touch.
   *  The board runner uses this to serialise DAG-independent tasks whose
   *  footprints overlap, preventing worktree merge conflicts. Populated
   *  by the planner; user can edit. Empty array = no known footprint. */
  likelyPaths: string[];
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

/**
 * Setup / teardown hook attached to a TestCase (Phase 3c).
 *
 * A hook is a stripped-down case — no assertions, no lastRun, no retry. Its
 * job is to mutate external state so the main case can run cleanly: seed a
 * test user, reset a DB, etc.
 *
 * Setup hook failures HALT the case. Teardown hook failures are recorded as
 * warnings but do not flip the main result.
 */
export interface TestCaseHook {
  id: string;
  kind: "api" | "shell";
  /** Display label for the hook in the UI. */
  label?: string;
  // API kind
  method?: string;
  path?: string;
  body?: string;
  headers?: string;
  // Shell kind
  command?: string;
}

/**
 * A typed assertion the test runner evaluates against an API response or
 * shell-command result. Each test case carries an ordered list; all must
 * pass for the case to be considered green.
 */
export type Assertion =
  | { kind: "status"; equals: number }
  | { kind: "status_in"; values: number[] }
  | { kind: "header"; name: string; equals?: string; matches?: string }
  | { kind: "body_contains"; text: string }
  | { kind: "body_matches"; pattern: string }
  | { kind: "json_path"; path: string; equals?: unknown; matches?: string; exists?: boolean }
  | { kind: "response_time_ms"; lt: number }
  | { kind: "exit_code"; equals: number };

/** A concrete, runnable test case for a single criterion. */
export interface TestCase {
  id: string;
  /** Index into Task.successCriteria — which criterion this case verifies. */
  criterionIndex: number;
  label: string;
  kind: "api" | "shell";
  // ── API kind ────────────────────────────────────────
  method?: string;
  path?: string;
  body?: string;
  headers?: string;
  /** @deprecated Use `assertions` instead. Read at run time via `deriveAssertions()` for back-compat. */
  expectedStatus?: number;
  /** @deprecated Use `assertions` instead. Read at run time via `deriveAssertions()` for back-compat. */
  expectedBodyContains?: string;
  // ── Shell kind ──────────────────────────────────────
  command?: string;
  /** @deprecated Use `assertions` instead. */
  expectedExitCode?: number;
  // ── Typed assertions (Phase 2) ──────────────────────
  /** Ordered list of assertions; ALL must pass for the case to be green. */
  assertions?: Assertion[];
  // ── Lifecycle (Phase 3) ─────────────────────────────
  /** Per-case request/command timeout in milliseconds. Default 30_000.
   *  Server clamps API requests to [100, 120_000]. */
  timeoutMs?: number;
  /** Retry policy on failure. count = additional attempts after the first
   *  failure; backoffMs = delay between attempts. Default: no retries. */
  retry?: { count: number; backoffMs: number };
  /** Free-form tags used for filtering runs ("smoke", "regression", "slow"). */
  tags?: string[];
  /** Hooks run BEFORE the main assertion phase. Used to seed state (e.g.
   *  create a test user, reset the DB). A failed setup halts the case
   *  immediately — assertions are not evaluated. */
  setup?: TestCaseHook[];
  /** Hooks run AFTER assertion evaluation, regardless of pass/fail. Used to
   *  clean up (delete created rows, log out, etc.). Failures here surface
   *  as warnings — they don't flip a passed case to failed. */
  teardown?: TestCaseHook[];
  // ── Coverage taxonomy (PRD_OPEN_SOURCE §B) ─────────────────────────────
  /** Which class of behavior this case exercises. Used by the planner + case
   *  generator to enforce broad coverage, and by the UI to display badges.
   *  Absent → treated as `happy` for backward-compat with older test cases. */
  category?: "happy" | "edge" | "negative" | "error" | "boundary" | "perf";
  // ── Heuristic transparency ─────────────────────────
  /** Free-form notes the generator left explaining how this case was inferred. */
  notes?: string;
  /** Used by sequence cases — the prior case's response.id will be substituted into `path` / `body` placeholders like `{{prev.id}}` at run time. */
  dependsOnCaseId?: string;
  // ── Last run result (refreshed each time the user runs it) ─────────────
  lastRun?: {
    passed: boolean;
    durationMs: number;
    actualStatus?: number;
    actualExitCode?: number;
    output: string;
    ranAt: string;
    /** Per-assertion breakdown so the UI can show *why* a case passed/failed. */
    assertions?: AssertionResult[];
    /** Parsed JSON of the response body, when the response was valid JSON.
     * Used by sequence cases for {{prev.<key>}} templating — far more
     * reliable than parsing the truncated `output` string after the fact. */
    responseJson?: unknown;
    /** How many attempts were made (1 + retries). 1 means no retries used. */
    attempts?: number;
    /** True iff the run was killed by the configured timeout. */
    timedOut?: boolean;
  };
}

export interface AssertionResult {
  /** Short label, e.g. "Status code", "Body contains", "Exit code". */
  label: string;
  passed: boolean;
  /** What we expected — already humanized for display. */
  expected: string;
  /** What we actually got — already humanized. */
  actual: string;
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
