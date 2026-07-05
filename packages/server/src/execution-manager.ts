import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { getDb, rowToTask } from "./db.ts";
import { spawnClaudeCode } from "../../core/src/adapters/claude-code.ts";
import { runTests } from "../../core/src/adapters/test-runner.ts";
import { WorktreeManager } from "../../core/src/adapters/worktree.ts";
import { McpConfigManager } from "../../core/src/adapters/mcp-config.ts";
import { parseTelemetry, extractMetrics } from "../../core/src/telemetry/parser.ts";
import { capturePostExecutionArtifacts } from "../../core/src/adapters/post-execution.ts";
import { autoCommit as autoCommitFn, autoPr as autoPrFn } from "../../core/src/adapters/commit-agent.ts";
import { recordReplayEvent } from "./testing/replay-recorder.ts";
import { sendWebhook, type WebhookEvent } from "../../core/src/adapters/webhook.ts";
import type { PermissionMode, TddPhase } from "../../core/src/types/index.ts";
import { DEFAULT_PERMISSION_MODE } from "../../core/src/types/index.ts";
import type { StreamEvent } from "../../core/src/types/stream-json.ts";
import { resolveDbPath, resolveProjectRoot } from "../../core/src/storage/paths.ts";

const MAX_CONCURRENT = 3;
// User-owned data (DB, worktrees, MCP configs) lives at the project root
// (the user's CWD when running `npx agent-trail`, or AGENT_TRAIL_ROOT).
const REPO_ROOT = resolveProjectRoot();
const DB_PATH = resolveDbPath(REPO_ROOT);
// The ask-human MCP entry ships with the server package; resolve it relative
// to this file so it keeps working when installed under node_modules.
const ASK_HUMAN_SCRIPT = join(import.meta.dir, "../../core/src/mcp/ask-human.ts");

interface ExecutionState {
  executionId: string;
  taskId: string;
  subscribers: ReadableStreamDefaultController<Uint8Array>[];
  // Child handle for the running `claude` CLI. null for verify_tests (which
  // uses runTests directly) and before spawn happens.
  proc: ChildProcess | null;
  // Set by stop() so finalize() can pick a meaningful error message instead
  // of the generic "claude exited with signal SIGTERM" string from the adapter.
  cancelled: boolean;
}

interface QueuedRun {
  taskId: string;
  decision?: { question: string; answer: string };
  resolve: (result: { executionId: string } | { error: string }) => void;
}

class ExecutionManager {
  private active = new Map<string, ExecutionState>();
  private queue: QueuedRun[] = [];
  private worktrees = new WorktreeManager(REPO_ROOT);
  private mcpConfigs = new McpConfigManager(REPO_ROOT);
  private enc = new TextEncoder();
  private taskCompletionListeners = new Map<string, (status: string) => void>();
  private boardRunning = new Set<string>();
  private crashRecoveryDone = false;

  get concurrentCount() {
    return this.active.size;
  }

  get queuedCount() {
    return this.queue.length;
  }

  get maxConcurrent() {
    return MAX_CONCURRENT;
  }

  isBoardRunning(boardId: string): boolean {
    return this.boardRunning.has(boardId);
  }

  /**
   * PRD 1.10 fix (v1-bug-5): on server startup, any `running` execution rows
   * are ghosts from the previous process — the child claude CLI is gone and
   * no one is listening on SSE anymore. Mark them `failed` with a clear
   * reason and drop the parent tasks back to `blocked` so the UI unsticks.
   *
   * Called at most once, lazily on first `start()` — keeps the constructor
   * free of side-effects and side-steps the singleton import-time DB open.
   */
  recoverFromCrash(): void {
    if (this.crashRecoveryDone) return;
    this.crashRecoveryDone = true;
    const db = getDb();
    const orphans = db.query(
      "SELECT id, task_id, claude_session_id FROM executions WHERE status = 'running'",
    ).all() as Array<{ id: string; task_id: string; claude_session_id: string | null }>;
    if (orphans.length === 0) return;
    const now = new Date().toISOString();
    for (const { id, task_id, claude_session_id } of orphans) {
      db.query(
        "UPDATE executions SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?",
      ).run(now, "Server restarted while this execution was in flight", id);
      // PRD_OPEN_SOURCE 2.2 — if we captured claude's session_id, surface it
      // so the UI can offer a one-click resume rather than restart-from-scratch.
      const hint = claude_session_id
        ? `Server restarted mid-run — resume with session ${claude_session_id.slice(0, 8)}… or retry`
        : "Server restarted mid-run — please retry";
      db.query(
        "UPDATE tasks SET status = 'blocked', active_form = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'",
      ).run(hint, now, task_id);
    }
    console.log(`[execution-manager] recovered ${orphans.length} orphan execution(s) after restart`);
  }

  /**
   * PRD_OPEN_SOURCE 2.2 — resume a previously killed execution.
   * Looks up the most recent execution for this task that has a claude
   * session_id, then dispatches through `_run` with a resume hint the
   * adapter feeds to `claude --resume`.
   */
  async resumeSession(taskId: string): Promise<{ executionId: string } | { error: string }> {
    const db = getDb();
    const row = db.query(
      `SELECT claude_session_id FROM executions
        WHERE task_id = ? AND claude_session_id IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
    ).get(taskId) as { claude_session_id: string | null } | null;
    const sid = row?.claude_session_id;
    if (!sid) return { error: "no prior claude session found for this task" };
    return this._run(taskId, undefined, { resumeSessionId: sid });
  }

  // ─── SSE ─────────────────────────────────────────────────────────────────────

  subscribe(taskId: string): ReadableStream<Uint8Array> {
    const self = this;
    let _ctrl: ReadableStreamDefaultController<Uint8Array>;
    return new ReadableStream<Uint8Array>({
      start(ctrl) {
        _ctrl = ctrl;
        const state = self.active.get(taskId);
        if (state) {
          state.subscribers.push(ctrl);
          ctrl.enqueue(self.sse({ type: "connected", executionId: state.executionId }));
        } else {
          ctrl.enqueue(self.sse({ type: "idle" }));
          ctrl.close();
        }
      },
      cancel() {
        const state = self.active.get(taskId);
        if (state) state.subscribers = state.subscribers.filter((s) => s !== _ctrl);
      },
    });
  }

  private sse(data: object): Uint8Array {
    return this.enc.encode(`data: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(taskId: string, data: object): void {
    const state = this.active.get(taskId);
    if (!state) return;
    const chunk = this.sse(data);
    for (const ctrl of state.subscribers) {
      try { ctrl.enqueue(chunk); } catch { /* disconnected */ }
    }
    // PRD_OPEN_SOURCE 2.8 — mirror every SSE event to a JSONL file per
    // execution. Cheap append (fs is sync, we log a handful per second)
    // gives us a self-contained recording for later replay / clip export.
    recordReplayEvent(state.executionId, data);
  }

  private closeAll(taskId: string): void {
    const state = this.active.get(taskId);
    if (!state) return;
    for (const ctrl of state.subscribers) {
      try { ctrl.close(); } catch { /* already closed */ }
    }
    state.subscribers = [];
  }

  // ─── Start ───────────────────────────────────────────────────────────────────

  async start(taskId: string): Promise<{ executionId: string } | { error: string }> {
    return this._run(taskId);
  }

  // ─── Board runner ─────────────────────────────────────────────────────────

  async runBoard(boardId: string): Promise<{ scheduledCount: number } | { error: string }> {
    if (this.boardRunning.has(boardId)) return { error: "Board run already in progress" };
    const db = getDb();
    const count = (
      db
        .query("SELECT COUNT(*) as n FROM tasks WHERE board_id = ? AND status IN ('backlog','ready')")
        .get(boardId) as { n: number } | null
    )?.n ?? 0;
    if (count === 0) return { error: "No runnable tasks (all done, blocked, or in review)" };
    this.boardRunning.add(boardId);
    this._boardRunLoop(boardId).catch((err) => {
      console.error(`[board-runner:${boardId}]`, err);
      this.boardRunning.delete(boardId);
    });
    return { scheduledCount: count };
  }

  private async _awaitTask(taskId: string): Promise<string> {
    const db = getDb();
    const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null;
    const terminal = ["done", "in_review", "blocked", "failed"];
    if (row && terminal.includes(row.status)) return row.status;
    return new Promise<string>((resolve) => {
      this.taskCompletionListeners.set(taskId, resolve);
    });
  }

  private async _boardRunLoop(boardId: string): Promise<void> {
    const db = getDb();

    try {
      while (true) {
        const rows = db
          .query("SELECT * FROM tasks WHERE board_id = ? ORDER BY created_at")
          .all(boardId) as Parameters<typeof rowToTask>[0][];
        const tasks = rows.map(rowToTask);

        const doneIds = new Set(
          tasks.filter((t) => t.status === "done" || t.status === "in_review").map((t) => t.id),
        );
        const inProgress = tasks.filter((t) => t.status === "in_progress");

        // Wait for any currently running tasks before advancing
        if (inProgress.length > 0) {
          await Promise.race(inProgress.map((t) => this._awaitTask(t.id)));
          continue;
        }

        // Find the next runnable task (dependencies all complete)
        const next = tasks.find(
          (t) =>
            (t.status === "backlog" || t.status === "ready") &&
            t.dependsOn.every((dep) => doneIds.has(dep)),
        );

        if (!next) break; // nothing left to run — done or permanently blocked

        const result = await this.start(next.id);
        if ("error" in result) break; // e.g. max concurrent hit — stop

        const finalStatus = await this._awaitTask(next.id);
        if (finalStatus === "blocked") break; // task failed or needs human input
      }
    } finally {
      this.boardRunning.delete(boardId);
    }
  }

  // ─── Scope runner (epic / sprint) ─────────────────────────────────────────

  async runScope(
    boardId: string,
    scopeType: "epic" | "sprint",
    scopeName: string,
  ): Promise<{ scheduledCount: number; blockers: BlockerInfo[] } | { error: string }> {
    if (this.boardRunning.has(boardId)) return { error: "A run is already in progress for this board" };

    const db = getDb();
    const col = scopeType === "epic" ? "epic" : "sprint";
    const rows = db
      .query(`SELECT * FROM tasks WHERE board_id = ? AND ${col} = ?`)
      .all(boardId, scopeName) as Parameters<typeof rowToTask>[0][];
    const scopeTasks = rows.map(rowToTask);

    if (scopeTasks.length === 0) {
      return { error: `No tasks found in ${scopeType} "${scopeName}"` };
    }

    const scopeTaskIds = new Set(scopeTasks.map((t) => t.id));

    // Load all board tasks for dependency checking
    const allRows = db
      .query("SELECT * FROM tasks WHERE board_id = ?")
      .all(boardId) as Parameters<typeof rowToTask>[0][];
    const taskMap = new Map(allRows.map(rowToTask).map((t) => [t.id, t]));

    // Find blockers: runnable scope tasks depending on non-done out-of-scope tasks
    const seen = new Set<string>();
    const blockers: BlockerInfo[] = [];
    for (const t of scopeTasks) {
      if (["done", "in_review", "in_progress", "blocked"].includes(t.status)) continue;
      for (const depId of t.dependsOn) {
        if (scopeTaskIds.has(depId)) continue; // within-scope, handled by DAG
        const dep = taskMap.get(depId);
        if (!dep) continue;
        if (dep.status === "done" || dep.status === "in_review") continue;
        const key = `${t.id}:${depId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blockers.push({
          taskId: t.id, taskTitle: t.title,
          blockedById: dep.id, blockedByTitle: dep.title,
          blockedByEpic: dep.epic, blockedBySprint: dep.sprint, blockedByStatus: dep.status,
        });
      }
    }

    if (blockers.length > 0) return { scheduledCount: 0, blockers };

    const runnable = scopeTasks.filter((t) => t.status === "backlog" || t.status === "ready");
    if (runnable.length === 0) return { scheduledCount: 0, blockers: [] };

    this.boardRunning.add(boardId);
    this._scopeRunLoop(boardId, scopeTaskIds).catch((err) => {
      console.error(`[scope-runner:${boardId}]`, err);
      this.boardRunning.delete(boardId);
    });

    return { scheduledCount: runnable.length, blockers: [] };
  }

  private async _scopeRunLoop(boardId: string, scopeTaskIds: Set<string>): Promise<void> {
    const db = getDb();
    try {
      while (true) {
        const allRows = db
          .query("SELECT * FROM tasks WHERE board_id = ? ORDER BY created_at")
          .all(boardId) as Parameters<typeof rowToTask>[0][];
        const allTasks = allRows.map(rowToTask);
        const scopeTasks = allTasks.filter((t) => scopeTaskIds.has(t.id));

        const doneIds = new Set(
          allTasks.filter((t) => t.status === "done" || t.status === "in_review").map((t) => t.id),
        );
        const inProgress = scopeTasks.filter((t) => t.status === "in_progress");

        if (inProgress.length > 0) {
          await Promise.race(inProgress.map((t) => this._awaitTask(t.id)));
          continue;
        }

        const next = scopeTasks.find(
          (t) =>
            (t.status === "backlog" || t.status === "ready") &&
            t.dependsOn.every((dep) => doneIds.has(dep)),
        );

        if (!next) break;

        const result = await this.start(next.id);
        if ("error" in result) break;

        const finalStatus = await this._awaitTask(next.id);
        if (finalStatus === "blocked") break;
      }
    } finally {
      this.boardRunning.delete(boardId);
    }
  }

  /** Resume a task after a human decision has been answered. */
  async resume(
    taskId: string,
    question: string,
    answer: string,
  ): Promise<{ executionId: string } | { error: string }> {
    return this._run(taskId, { question, answer });
  }

  private async _run(
    taskId: string,
    decision?: { question: string; answer: string },
    resume?: { resumeSessionId: string },
  ): Promise<{ executionId: string } | { error: string }> {
    if (this.active.has(taskId)) {
      return { error: "Task already running" };
    }
    if (this.queue.some((q) => q.taskId === taskId)) {
      return { error: "Task already queued" };
    }

    // At capacity → queue, resolve when a slot opens
    if (this.active.size >= MAX_CONCURRENT) {
      return new Promise((resolve) => {
        this.queue.push({ taskId, decision, resolve });
        console.log(`[execution-manager] queued ${taskId} (queue depth=${this.queue.length})`);
      });
    }

    // Reserve the slot SYNCHRONOUSLY before any `await`, otherwise multiple
    // concurrent start() calls all see active.size < MAX, all clear the gate,
    // and MAX_CONCURRENT is silently violated. We backfill executionId once
    // we mint it below — subscribers see "connected" with an empty id during
    // the tiny window between reservation and DB insert, which is harmless
    // (the SSE handler doesn't act on it).
    const state: ExecutionState = {
      executionId: "",
      taskId,
      subscribers: [],
      proc: null,
      cancelled: false,
    };
    this.active.set(taskId, state);

    let db: ReturnType<typeof getDb>;
    let task: ReturnType<typeof rowToTask>;
    let permissionMode: PermissionMode;
    let implementationDir: string | null;
    let executionTimeoutMs: number;
    let executionId: string;
    let now: string;
    let taskCwd: string;
    // PRD_OPEN_SOURCE 2.3 — budget state hoisted out of the try/catch so
    // the onEvent + onComplete closures below can reach it (they run long
    // after the try block returns). 2.5/2.6 auto-commit/auto-pr similarly.
    let costCapUsd = 0;
    let tokenCap = 0;
    let budgetActive = false;
    let budgetTripped = false;
    let runningIn = 0, runningOut = 0;
    const PRICE_IN  = 3.00;
    const PRICE_OUT = 15.00;
    const usdSoFar = () => (runningIn / 1_000_000) * PRICE_IN + (runningOut / 1_000_000) * PRICE_OUT;
    let autoCommit = false;
    let autoPr = false;
    let commitStyle = "conventional";
    try {
      db = getDb();
      const taskRow = db
        .query("SELECT * FROM tasks WHERE id = ?")
        .get(taskId) as Parameters<typeof rowToTask>[0] | null;
      if (!taskRow) {
        this.active.delete(taskId);
        this._drainQueue();
        return { error: "Task not found" };
      }

      task = rowToTask(taskRow);

      // Look up board config (permission mode + implementation directory + timeout)
      const boardRow = db
        .query("SELECT permission_mode, implementation_dir, execution_timeout_ms, execution_cost_cap_usd, execution_token_cap, auto_commit, auto_pr, commit_style FROM boards WHERE id = ?")
        .get(task.boardId) as {
          permission_mode: string | null; implementation_dir: string | null; execution_timeout_ms: number | null;
          execution_cost_cap_usd: number | null; execution_token_cap: number | null;
          auto_commit: number | null; auto_pr: number | null; commit_style: string | null;
        } | null;
      permissionMode = (boardRow?.permission_mode ?? DEFAULT_PERMISSION_MODE) as PermissionMode;
      implementationDir = boardRow?.implementation_dir ?? null;
      executionTimeoutMs = boardRow?.execution_timeout_ms ?? 1_200_000;
      costCapUsd  = Number(boardRow?.execution_cost_cap_usd ?? 0);
      tokenCap    = Number(boardRow?.execution_token_cap ?? 0);
      budgetActive = costCapUsd > 0 || tokenCap > 0;
      autoCommit  = Boolean(boardRow?.auto_commit ?? 0);
      autoPr      = Boolean(boardRow?.auto_pr ?? 0);
      commitStyle = boardRow?.commit_style ?? "conventional";
      executionId = crypto.randomUUID();
      state.executionId = executionId;
      now = new Date().toISOString();

      db.query(
        "INSERT INTO executions (id, task_id, status, agent_kind, tdd_phase, started_at) VALUES (?, ?, 'running', ?, ?, ?)",
      ).run(executionId, taskId, task.assignee, task.tddPhase, now);

      // Resolve where Claude (and later, tests) should run for this task.
      //   1. Board's implementation_dir if set (the v0.1.1 default)
      //   2. Git worktree under the vibe-board repo (legacy / dev mode)
      //   3. REPO_ROOT (last resort — surfaces the fallback warning in the UI)
      taskCwd =
        implementationDir ??
        (await this.worktrees.create(taskId)) ??
        REPO_ROOT;

      // Persist the cwd onto the task so /test reads the same place Claude wrote to.
      db.query(
        "UPDATE tasks SET status = 'in_progress', worktree_path = ?, updated_at = ? WHERE id = ?",
      ).run(taskCwd, now, taskId);
    } catch (err) {
      // Anything blew up before we wired callbacks — release the slot and rethrow.
      this.active.delete(taskId);
      this._drainQueue();
      throw err;
    }

    // ─── verify_tests: run test suite directly, no Claude ────────────────────
    if (task.tddPhase === "verify_tests") {
      const worktreePath = taskCwd;
      this.broadcast(taskId, { type: "text", text: "Running test suite…" });

      runTests(worktreePath).then((result) => {
        // If stop() ran while the test process was in flight, it already
        // wrote a "Cancelled by user" terminal state and removed the entry
        // from this.active. Don't overwrite that.
        if (state.cancelled || !this.active.has(taskId)) return;

        const finishedAt = new Date().toISOString();
        const status = result.passed ? "completed" : "failed";

        db.query(
          "UPDATE executions SET status = ?, finished_at = ?, duration_ms = ?, error_message = ? WHERE id = ?",
        ).run(status, finishedAt, result.durationMs, result.passed ? null : result.output.slice(0, 2000), executionId);

        // Store test output as artifact
        db.query(
          "INSERT INTO artifacts (id, task_id, execution_id, kind, content, created_at) VALUES (?, ?, ?, 'test_output', ?, ?)",
        ).run(crypto.randomUUID(), taskId, executionId, result.output, finishedAt);

        const nextStatus = result.passed ? "in_review" : "blocked";
        const lastError = result.passed ? null : `Tests failed (exit ${result.exitCode})`;
        db.query(
          "UPDATE tasks SET status = ?, active_form = NULL, last_error = ?, updated_at = ? WHERE id = ?",
        ).run(nextStatus, lastError, finishedAt, taskId);

        this.broadcast(taskId, {
          type: "test_result",
          passed: result.passed,
          exitCode: result.exitCode,
          output: result.output.slice(0, 500),
        });
        this.broadcast(taskId, { type: "execution_complete", status, executionId });
        this.closeAll(taskId);
        this.active.delete(taskId);
        fireWebhook(taskId, executionId, result.passed ? "task_completed" : "task_failed", db);
        const listener = this.taskCompletionListeners.get(taskId);
        if (listener) { this.taskCompletionListeners.delete(taskId); listener(status); }
        this._drainQueue();
      });

      return { executionId };
    }

    // ─── Claude Code execution ────────────────────────────────────────────────
    const worktreePath = taskCwd;
    const mcpConfigPath = this.mcpConfigs.write(taskId, task.mcps, {
      taskId,
      executionId,
      dbPath: DB_PATH,
      scriptPath: ASK_HUMAN_SCRIPT,
    });

    let seqNum = 0;
    let completionHandled = false;
    // Track every ask_human invocation by tool_use id. We only treat it as
    // "awaiting human" when (a) the matching tool_result came back without
    // is_error AND (b) a decision_tickets row was actually written. This
    // protects against MCP crashes or transport errors that would otherwise
    // strand the task in `blocked` with no ticket to answer.
    const pendingAskHumanIds = new Set<string>();
    const successfulAskHumanIds = new Set<string>();

    const finalize = (status: "completed" | "failed" | "awaiting_human", errorMessage?: string) => {
      if (completionHandled) return;
      completionHandled = true;

      // If stop() flagged this run, override the adapter's generic
      // "signal SIGTERM" message with something the UI can present directly.
      const effectiveError = state.cancelled ? "Cancelled by user" : errorMessage;
      const effectiveStatus = state.cancelled ? "failed" : status;

      const finishedAt = new Date().toISOString();
      const dbStatus = effectiveStatus === "awaiting_human" ? "awaiting_human" : effectiveStatus;
      db.query(
        "UPDATE executions SET status = ?, finished_at = ?, error_message = ? WHERE id = ?",
      ).run(dbStatus, finishedAt, effectiveError ?? null, executionId);

      // ─── TDD gate auto-advance (PRD 1.5) ─────────────────────────────────
      // If this task is TDD-enabled and the phase we just finished has a
      // next-phase, roll straight into it. Keeps task.status='in_progress',
      // updates tdd_phase, and re-runs — the completion listener + drain
      // queue only fire when we reach a real terminal state.
      const advanceTarget =
        effectiveStatus === "completed" && task.tddEnabled ? nextTddPhase(task.tddPhase) : null;
      if (advanceTarget) {
        db.query(
          "UPDATE tasks SET tdd_phase = ?, active_form = NULL, last_error = NULL, updated_at = ? WHERE id = ?",
        ).run(advanceTarget, finishedAt, taskId);
        this.broadcast(taskId, { type: "execution_complete", status: "completed", executionId });
        this.closeAll(taskId);
        this.active.delete(taskId);
        this.mcpConfigs.cleanup(taskId);
        // Do NOT fire task completion listener — the board runner is still
        // waiting on the whole task, not a phase. Async re-entry avoids
        // recursing inside the adapter callback that got us here.
        queueMicrotask(() => {
          void this._run(taskId).catch((err) => console.error(`[tdd-advance] ${taskId}: ${err}`));
        });
        this._drainQueue();
        return;
      }

      const nextTaskStatus =
        effectiveStatus === "completed" ? "in_review"
        : effectiveStatus === "awaiting_human" ? "blocked"
        : "blocked";

      // Populate last_error on failure; clear it on any non-failure outcome
      // (completed OR awaiting_human) so a stale message from a previous run
      // doesn't linger after the task makes progress.
      const nextLastError = effectiveStatus === "failed" ? (effectiveError ?? "Execution failed") : null;
      db.query(
        "UPDATE tasks SET status = ?, active_form = NULL, last_error = ?, updated_at = ? WHERE id = ?",
      ).run(nextTaskStatus, nextLastError, finishedAt, taskId);

      const broadcastStatus = effectiveStatus === "awaiting_human" ? "failed" : effectiveStatus;
      this.broadcast(taskId, {
        type: effectiveStatus === "awaiting_human" ? "awaiting_human" : "execution_complete",
        status: broadcastStatus,
        executionId,
      });
      this.closeAll(taskId);
      this.active.delete(taskId);
      this.mcpConfigs.cleanup(taskId);
      fireWebhook(taskId, executionId, effectiveStatus, db);
      const listener = this.taskCompletionListeners.get(taskId);
      if (listener) { this.taskCompletionListeners.delete(taskId); listener(effectiveStatus); }
      this._drainQueue();
    };

    // Build the prompt — include decision context if resuming
    const taskWithDecision = decision
      ? {
          ...task,
          description: [
            task.description,
            "",
            "--- RESUMED AFTER HUMAN DECISION ---",
            `Question you asked: ${decision.question}`,
            `Human answer: ${decision.answer}`,
            "Continue from where you left off.",
          ].join("\n"),
        }
      : task;

    const proc = spawnClaudeCode({
      task: taskWithDecision,
      worktreePath,
      mcpConfigPath,
      permissionMode,
      timeoutMs: executionTimeoutMs,
      resumeSessionId: resume?.resumeSessionId,
      callbacks: {
        onEvent: (raw, parsed) => {
          // PRD_OPEN_SOURCE 2.2 — capture claude session_id as soon as it
          // arrives (system init event). Persisting eagerly means a crashed
          // execution still has a session id to resume with next boot.
          const anyEv = parsed as { type?: string; session_id?: string };
          if (anyEv.session_id) {
            db.query(
              "UPDATE executions SET claude_session_id = ? WHERE id = ? AND (claude_session_id IS NULL OR claude_session_id = '')",
            ).run(anyEv.session_id, executionId);
          }

          // PRD_OPEN_SOURCE 2.3 — accumulate token usage per assistant turn
          // and trip the cap if the caller enabled one. We stop the child
          // via the same SIGTERM path stop() uses, then write a decision
          // ticket so the user can approve or extend the cap.
          if (budgetActive && !budgetTripped && parsed.type === "assistant") {
            const u = (parsed as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } }).message?.usage;
            if (u) {
              runningIn  += Number(u.input_tokens ?? 0);
              runningOut += Number(u.output_tokens ?? 0);
            }
            const usd = usdSoFar();
            const overCost  = costCapUsd  > 0 && usd >= costCapUsd;
            const overToken = tokenCap    > 0 && (runningIn + runningOut) >= tokenCap;
            if (overCost || overToken) {
              budgetTripped = true;
              const reason = overCost
                ? `Cost cap reached: $${usd.toFixed(3)} ≥ $${costCapUsd.toFixed(2)}`
                : `Token cap reached: ${(runningIn + runningOut).toLocaleString()} ≥ ${tokenCap.toLocaleString()}`;
              // Insert a decision ticket so the human can decide (raise cap /
              // abort). The task will land `blocked` when finalize fires.
              try {
                db.query(
                  `INSERT INTO decision_tickets (id, task_id, execution_id, question, context, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                ).run(
                  crypto.randomUUID(), taskId, executionId,
                  "Budget cap reached — continue or abort?",
                  reason,
                  new Date().toISOString(),
                );
              } catch { /* ignore duplicate insert */ }
              // Kill the child; finalize() picks up on the close event.
              const proc = state.proc;
              if (proc?.pid) {
                try { process.kill(-proc.pid, "SIGTERM"); }
                catch { try { proc.kill("SIGTERM"); } catch { /* gone */ } }
              }
              state.cancelled = false; // NOT a user cancel — different UI copy
              // Broadcast a heads-up event so the UI can pop the ticket panel.
              this.broadcast(taskId, { type: "text", text: `[BUDGET] ${reason}` });
            }
          }
          // Detect ask_human tool_use directly from the stream — far more
          // reliable than string-matching the final result text.
          if (parsed.type === "assistant") {
            for (const block of parsed.message.content) {
              if (block.type === "tool_use" && isAskHumanTool(block.name)) {
                pendingAskHumanIds.add(block.id);
              }
            }
          } else if (parsed.type === "user") {
            for (const block of parsed.message.content) {
              if (block.type === "tool_result" && pendingAskHumanIds.has(block.tool_use_id) && !block.is_error) {
                successfulAskHumanIds.add(block.tool_use_id);
              }
            }
          }

          const tel = parseTelemetry(parsed, raw);
          if (tel) {
            db.query(
              `INSERT INTO telemetry_events
                (id, execution_id, task_id, seq_num, kind, tool_name, tool_input, tool_result, text_content, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              crypto.randomUUID(), executionId, taskId, seqNum++,
              tel.kind, tel.toolName, tel.toolInput, tel.toolResult, tel.textContent, tel.rawJson,
            );
          }
          const ui = toUiEvent(parsed);
          if (ui) {
            db.query("UPDATE tasks SET active_form = ?, updated_at = ? WHERE id = ?").run(
              JSON.stringify(ui), new Date().toISOString(), taskId,
            );
            this.broadcast(taskId, ui);
          }
        },

        onComplete: (result) => {
          const m = extractMetrics(result);
          db.query(
            "UPDATE executions SET duration_ms = ?, total_input_tokens = ?, total_output_tokens = ?, claude_session_id = ? WHERE id = ?",
          ).run(m.durationMs, m.totalInputTokens, m.totalOutputTokens, result.session_id ?? null, executionId);

          // PRD_OPEN_SOURCE 2.3 — if a budget cap wrote a ticket, treat as
          // awaiting_human so the human sees the ticket rather than a bare
          // "failed" state.
          if (budgetTripped) {
            finalize("awaiting_human");
            return;
          }

          // Treat as awaiting_human ONLY when the model successfully called
          // ask_human AND a decision_tickets row exists for this execution.
          // The DB cross-check catches edge cases where the tool_result came
          // back ok but the MCP server failed to persist the ticket.
          if (successfulAskHumanIds.size > 0) {
            const ticketCount = (
              db
                .query("SELECT COUNT(*) AS n FROM decision_tickets WHERE execution_id = ? AND answered_at IS NULL")
                .get(executionId) as { n: number } | null
            )?.n ?? 0;
            if (ticketCount > 0) {
              finalize("awaiting_human");
              return;
            }
            // Tool reported success but no ticket landed — fail loudly rather than hang.
            console.warn(
              `[execution-manager] ${taskId}: ask_human reported success but no decision_tickets row found`,
            );
            finalize("failed", "ask_human MCP succeeded but no decision ticket was persisted");
            return;
          }

          if (pendingAskHumanIds.size > 0) {
            // ask_human was called but never produced a non-error tool_result.
            finalize("failed", "ask_human MCP call failed — check ask-human.ts logs");
            return;
          }

          capturePostExecutionArtifacts(taskId, executionId, worktreePath, db);

          // PRD_OPEN_SOURCE 2.5 + 2.6 — post-verify hooks. Only fire on the
          // TERMINAL success of the whole task (i.e. when the next TDD phase
          // is null); TDD auto-advance runs finalize("completed") between
          // phases too, and we don't want a mid-gate commit.
          const isTerminalSuccess = !task.tddEnabled || task.tddPhase === "verify_tests" || task.tddPhase === "implement_only";
          if (isTerminalSuccess && autoCommit) {
            try {
              const commit = autoCommitFn({
                worktreePath, task,
                style: (commitStyle as "conventional" | "plain") ?? "conventional",
              });
              this.broadcast(taskId, {
                type: "text",
                text: commit.performed
                  ? `[commit-agent] ${commit.message?.split("\n")[0] ?? "committed"}`
                  : `[commit-agent] skipped: ${commit.reason}`,
              });
              if (commit.performed && autoPr) {
                const pr = autoPrFn({ worktreePath, task });
                this.broadcast(taskId, {
                  type: "text",
                  text: pr.performed
                    ? `[auto-pr] ${pr.url ?? "PR opened"}`
                    : `[auto-pr] skipped: ${pr.reason}`,
                });
              }
            } catch (err) {
              console.warn(`[execution-manager] commit/pr hook failed:`, err);
            }
          }

          finalize("completed");
        },

        onError: (err) => {
          console.error(`[execution-manager] task ${taskId}:`, err.message);
          finalize("failed", err.message);
        },
      },
    });

    // Race condition note: spawnClaudeCode can short-circuit (no `claude` in
    // PATH) and synchronously invoke onError → finalize → this.active.delete.
    // In that case state is no longer in the map, so don't try to stash proc.
    if (proc && this.active.has(taskId)) state.proc = proc;

    return { executionId };
  }

  // ─── Stop / cancel ────────────────────────────────────────────────────────

  /**
   * Cancel a running or queued task.
   *  - If the task is queued, drop it; the waiting `start()` promise resolves
   *    with an error so the caller doesn't hang.
   *  - If the task is active, mark it cancelled and SIGTERM the whole process
   *    group (we spawn with detached:true). After 3s, SIGKILL anything still
   *    alive. The adapter's `close` event will then drive `finalize("failed",
   *    "Cancelled by user")`.
   */
  async stop(taskId: string): Promise<{ ok: boolean; error?: string }> {
    // 1. Dequeue if queued.
    const qi = this.queue.findIndex((q) => q.taskId === taskId);
    if (qi >= 0) {
      const [removed] = this.queue.splice(qi, 1);
      removed?.resolve({ error: "Cancelled before start" });
      return { ok: true };
    }

    // 2. Active? Mark + kill.
    const state = this.active.get(taskId);
    if (!state) return { ok: false, error: "Task is not running or queued" };

    state.cancelled = true;
    const proc = state.proc;
    if (!proc?.pid) {
      // verify_tests phase or pre-spawn — there's no child to kill. Force a
      // failed finalize directly so the UI doesn't sit on "in_progress".
      const db = getDb();
      const finishedAt = new Date().toISOString();
      db.query(
        "UPDATE executions SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?",
      ).run(finishedAt, "Cancelled by user", state.executionId);
      db.query(
        "UPDATE tasks SET status = 'blocked', active_form = NULL, last_error = ?, updated_at = ? WHERE id = ?",
      ).run("Cancelled by user", finishedAt, taskId);
      this.broadcast(taskId, { type: "execution_complete", status: "failed", executionId: state.executionId });
      this.closeAll(taskId);
      this.active.delete(taskId);
      this.mcpConfigs.cleanup(taskId);
      const listener = this.taskCompletionListeners.get(taskId);
      if (listener) { this.taskCompletionListeners.delete(taskId); listener("failed"); }
      this._drainQueue();
      return { ok: true };
    }

    const pid = proc.pid;
    try { process.kill(-pid, "SIGTERM"); }
    catch { try { proc.kill("SIGTERM"); } catch { /* gone */ } }

    setTimeout(() => {
      // If finalize hasn't fired yet, the child is still resisting — force-kill.
      if (this.active.get(taskId)?.proc?.pid === pid) {
        try { process.kill(-pid, "SIGKILL"); }
        catch { try { proc.kill("SIGKILL"); } catch { /* gone */ } }
      }
    }, 3000);

    return { ok: true };
  }

  private _drainQueue(): void {
    while (this.active.size < MAX_CONCURRENT && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      // _run will re-enter; safe because active.size is below MAX
      this._run(next.taskId, next.decision).then(next.resolve).catch((err) =>
        next.resolve({ error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }
}

// MCP tool names are namespaced as `mcp__<server>__<tool>` when injected through
// --mcp-config. Our server registers itself as `agent-trail`, so the full id is
// `mcp__agent-trail__ask_human`. Match by suffix so we survive renames.
function isAskHumanTool(name: string): boolean {
  return name === "ask_human" || name.endsWith("__ask_human");
}

/**
 * TDD-gate phase progression (PRD 1.5).
 *   write_tests  → implement       (agent wrote failing tests, now make them pass)
 *   implement    → verify_tests    (agent implemented, now run the suite)
 *   verify_tests → null            (terminal — pass lands `in_review`, fail lands `blocked`)
 *   implement_only → null          (TDD disabled; single-shot)
 *
 * Exported for tests to pin the contract.
 */
export function nextTddPhase(current: TddPhase): TddPhase | null {
  switch (current) {
    case "write_tests": return "implement";
    case "implement":   return "verify_tests";
    case "verify_tests":
    case "implement_only":
      return null;
  }
}

function fireWebhook(
  taskId: string,
  executionId: string,
  status: "completed" | "failed" | "awaiting_human",
  db: ReturnType<typeof getDb>,
): void {
  try {
    const row = db
      .query(
        `SELECT t.id, t.title, t.board_id, b.name AS board_name, b.webhook_url
         FROM tasks t JOIN boards b ON t.board_id = b.id WHERE t.id = ?`,
      )
      .get(taskId) as {
        id: string; title: string; board_id: string; board_name: string; webhook_url: string | null;
      } | null;

    if (!row?.webhook_url) return;

    const event: WebhookEvent = {
      event:
        status === "completed" ? "task_completed"
        : status === "awaiting_human" ? "awaiting_human"
        : "task_failed",
      board: { id: row.board_id, name: row.board_name },
      task: { id: row.id, title: row.title },
      executionId,
      timestamp: new Date().toISOString(),
    };

    sendWebhook(row.webhook_url, event).catch((err) =>
      console.warn(`[webhook] ${err.message}`),
    );
  } catch (err) {
    console.warn(`[webhook] lookup failed: ${err}`);
  }
}

function toUiEvent(event: StreamEvent): object | null {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "tool_use") {
        // PRD_FEED_EXPERIENCE F1.1 — surface the args so the client can build
        // a "Bash → bun test" / "Read → server.ts:40-120" card. Cap the raw
        // input at 4 KB so a huge Edit payload doesn't inflate every frame.
        const inputJson = JSON.stringify(block.input ?? {});
        return {
          type: "tool_call",
          tool: block.name,
          toolUseId: block.id,
          input: inputJson.length > 4000 ? inputJson.slice(0, 4000) + "…" : inputJson,
        };
      }
      if (block.type === "text" && block.text.trim()) {
        // Give the client more room for the "why-line" (F1.2).
        return { type: "text", text: block.text.slice(0, 500) };
      }
    }
  }
  if (event.type === "user") {
    const c = event.message.content[0];
    if (c?.type === "tool_result") {
      // F1.1 + F1.5 — the client needs the actual result text to extract
      // stdout tails, exit codes, error headlines. Cap output at 2 KB;
      // full text still lives in telemetry_events for detail views.
      const raw = typeof c.content === "string" ? c.content : String(c.content);
      return {
        type: "tool_result",
        isError: c.is_error,
        toolUseId: c.tool_use_id,
        content: raw.length > 2000 ? raw.slice(0, 2000) + "…" : raw,
      };
    }
  }
  return null;
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

export const executionManager = new ExecutionManager();
