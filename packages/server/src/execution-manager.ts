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
import { loadConstitution } from "../../core/src/context/store.ts";
import { foldConstitution } from "../../core/src/knowledge/fold.ts";
import { buildRiskIndex, formatRiskWarnings } from "../../core/src/knowledge/risk.ts";
import { resolveSymbolEdges } from "../../core/src/knowledge/edges.ts";
import { formatRetrievedFacts, retrieveForTask } from "../../core/src/knowledge/retrieval.ts";
import { projectProjectMap } from "../../core/src/knowledge/projections.ts";
import { resolveCodeIndex } from "../../core/src/knowledge/code-index.ts";
import {
  checkContractValidity, formatValidityWarning, gitHeadSha, rederiveContract,
  resolveSignatureSet,
} from "../../core/src/knowledge/validity.ts";

// §J step 3 — resolve `sym:` edges for an event's file footprint. Kept out of
// append() on purpose: append is synchronous and sits on the write path of
// every execution, and a symbol resolution that hangs must not stall an event
// write. Swallows everything — an edge is an optimization, the event is the
// record.
async function resolveSymbolEdgesFor(
  db: ReturnType<typeof getDb>,
  event: Parameters<typeof resolveSymbolEdges>[1],
): Promise<void> {
  try {
    if (!event?.paths?.length) return;
    const index = await resolveCodeIndex({ root: REPO_ROOT });
    await resolveSymbolEdges(db, event, index);
  } catch { /* best-effort by design */ }
}
import { renderContract, type CapabilityContract } from "../../core/src/knowledge/contracts.ts";
import { buildHeuristicMemory, buildL1Pack, writeTaskMemory } from "../../core/src/context/memory.ts";
import { rankRelevantFiles } from "../../core/src/context/repo-map.ts";
import { detectThrash, type ExecutionSample } from "../../core/src/loop/thrash.ts";
import { resolveLoopPolicy, type PartialLoopPolicy } from "../../core/src/loop/policy.ts";
import { buildIterationMemory, renderIterationHistory, type IterationSample } from "../../core/src/loop/iteration.ts";
import { nextTier } from "../../core/src/planner/models.ts";
import type { ModelTier } from "../../core/src/types/index.ts";
import { append as appendKnowledge } from "../../core/src/knowledge/store.ts";
import { extractContract } from "../../core/src/knowledge/contracts.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

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
  // knowledgelayer.md §4.6 seed — per-task SSE channels. Lifetime is the
  // manager, decoupled from ExecutionState. A subscriber that connects
  // BEFORE an execution starts stays open across the execution boundary;
  // one that connects mid-execution gets a backfill of recent telemetry
  // then joins the live tail. Both are required for the doc's Weeks 3-4
  // "walk in on a running agent" story.
  private taskChannels = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly KEEPALIVE_MS = 20_000;
  private static readonly BACKFILL_LIMIT = 200;

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
  //
  // Subscribers live on `taskChannels`, not on `active[taskId].subscribers`.
  // That's the fix for the pre-execute connect race: subscribers now persist
  // across execution boundaries, so a teammate who opens the feed of a task
  // that hasn't started yet stays connected when it does.

  subscribe(taskId: string): ReadableStream<Uint8Array> {
    const self = this;
    let _ctrl: ReadableStreamDefaultController<Uint8Array>;
    return new ReadableStream<Uint8Array>({
      start(ctrl) {
        _ctrl = ctrl;
        const chans = self.channelsFor(taskId);
        chans.add(ctrl);

        const state = self.active.get(taskId);
        if (state?.executionId) {
          ctrl.enqueue(self.sse({ type: "connected", executionId: state.executionId }));
          // Mid-execution join → replay recent telemetry so the client
          // has context before the live tail resumes.
          self.backfillTelemetry(ctrl, state.executionId);
        } else {
          ctrl.enqueue(self.sse({ type: "idle" }));
          // NOTE: do NOT close. The subscriber holds open through the next execute.
        }
        self.ensureKeepalive();
      },
      cancel() {
        const chans = self.taskChannels.get(taskId);
        if (!chans) return;
        chans.delete(_ctrl);
        if (chans.size === 0) self.taskChannels.delete(taskId);
      },
    });
  }

  private channelsFor(taskId: string): Set<ReadableStreamDefaultController<Uint8Array>> {
    let chans = this.taskChannels.get(taskId);
    if (!chans) { chans = new Set(); this.taskChannels.set(taskId, chans); }
    return chans;
  }

  private sse(data: object): Uint8Array {
    return this.enc.encode(`data: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(taskId: string, data: object): void {
    const chans = this.taskChannels.get(taskId);
    if (chans && chans.size > 0) {
      const chunk = this.sse(data);
      const dead: ReadableStreamDefaultController<Uint8Array>[] = [];
      for (const ctrl of chans) {
        try { ctrl.enqueue(chunk); } catch { dead.push(ctrl); }
      }
      for (const d of dead) chans.delete(d);
      if (chans.size === 0) this.taskChannels.delete(taskId);
    }
    // PRD_OPEN_SOURCE 2.8 — mirror every SSE event to a JSONL file per
    // execution. Cheap append (fs is sync, we log a handful per second)
    // gives us a self-contained recording for later replay / clip export.
    const state = this.active.get(taskId);
    if (state?.executionId) recordReplayEvent(state.executionId, data);
  }

  // Kept for API compatibility. Subscribers now persist across execution
  // boundaries so multiplayer teammates see the whole loop, not just the
  // current spawn. Callers previously used closeAll() to reset the list
  // after each finalize — with taskChannels-lifetime that reset is wrong.
  private closeAll(_taskId: string): void { /* intentional no-op — see comment */ }

  private ensureKeepalive(): void {
    if (this.keepaliveTimer) return;
    const chunk = this.enc.encode(": keepalive\n\n");
    this.keepaliveTimer = setInterval(() => {
      let live = 0;
      for (const [taskId, chans] of this.taskChannels) {
        const dead: ReadableStreamDefaultController<Uint8Array>[] = [];
        for (const ctrl of chans) {
          try { ctrl.enqueue(chunk); live++; } catch { dead.push(ctrl); }
        }
        for (const d of dead) chans.delete(d);
        if (chans.size === 0) this.taskChannels.delete(taskId);
      }
      if (live === 0 && this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }
    }, ExecutionManager.KEEPALIVE_MS);
    // Don't block process shutdown just because we're keepalive-ing.
    (this.keepaliveTimer as { unref?: () => void }).unref?.();
  }

  private backfillTelemetry(
    ctrl: ReadableStreamDefaultController<Uint8Array>,
    executionId: string,
  ): void {
    try {
      const rows = getDb().query(
        "SELECT kind, tool_name, tool_input, tool_result, text_content FROM telemetry_events " +
        "WHERE execution_id = ? ORDER BY seq_num ASC LIMIT ?",
      ).all(executionId, ExecutionManager.BACKFILL_LIMIT) as Array<{
        kind: string; tool_name: string | null; tool_input: string | null;
        tool_result: string | null; text_content: string | null;
      }>;
      if (rows.length === 0) return;
      ctrl.enqueue(this.sse({ type: "backfill_start", count: rows.length, executionId }));
      for (const r of rows) {
        if (r.kind === "tool_call") {
          ctrl.enqueue(this.sse({
            type: "tool_call",
            tool: r.tool_name,
            input: r.tool_input ? safeJson(r.tool_input) : undefined,
          }));
        } else if (r.kind === "tool_result") {
          ctrl.enqueue(this.sse({
            type: "tool_result",
            tool: r.tool_name,
            output: r.tool_result ? safeJson(r.tool_result) : undefined,
          }));
        } else if (r.kind === "text") {
          ctrl.enqueue(this.sse({ type: "text", text: r.text_content ?? "" }));
        }
        // 'thinking' / 'error' / 'system' stay internal — they'd confuse clients.
      }
      ctrl.enqueue(this.sse({ type: "backfill_end" }));
    } catch (err) {
      console.warn(`[sse-backfill] ${err instanceof Error ? err.message : String(err)}`);
    }
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

  // PRD 4.4 (§D slice) — persist a heuristic task memory after a successful
  // terminal execution. Downstream DAG tasks pick this up via buildL1Pack
  // (see the L0+L1 concat above). Best-effort — filesystem hiccups log a
  // warning but never fail the run that just succeeded.
  private async _persistTaskMemory(taskId: string, completedAt: string): Promise<void> {
    try {
      const db = getDb();
      const task = db
        .query("SELECT id, title, description, success_criteria, worktree_path FROM tasks WHERE id = ?")
        .get(taskId) as { id: string; title: string; description: string; success_criteria: string | null; worktree_path: string | null } | null;
      if (!task) return;
      const criteria = JSON.parse(task.success_criteria ?? "[]") as string[];

      // Grab the most recent git_diff + file_list artifacts.
      const gitDiff = (db
        .query("SELECT content FROM artifacts WHERE task_id = ? AND kind = 'git_diff' ORDER BY created_at DESC LIMIT 1")
        .get(taskId) as { content: string } | null)?.content;
      const fileListRaw = (db
        .query("SELECT content FROM artifacts WHERE task_id = ? AND kind = 'file_list' ORDER BY created_at DESC LIMIT 1")
        .get(taskId) as { content: string } | null)?.content;
      // file_list artifact is `git status --porcelain` output — one file per line, prefixed by status.
      const fileList = (fileListRaw ?? "")
        .split("\n")
        .map((l) => l.replace(/^\s*[A-Z?!]{1,2}\s+/, "").trim())
        .filter(Boolean);

      // Decision keys for this task = distinct question labels from tickets.
      const decisionRows = db
        .query("SELECT question FROM decision_tickets WHERE task_id = ?")
        .all(taskId) as { question: string }[];
      const decisionKeys = [...new Set(decisionRows.map((r) => r.question.slice(0, 60)))];

      const memory = buildHeuristicMemory({
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          successCriteria: criteria,
        },
        gitDiff,
        fileList,
        decisionKeys,
        completedAt,
      });
      writeTaskMemory(REPO_ROOT, memory);

      // knowledgelayer §4.1 — event-log form of the artifact. When the
      // task touched TypeScript/SQL files we ALSO extract a §4.2b
      // capability contract (structured exports/routes/tables/env/events)
      // and store that as the JSON body. Downstream tasks get exact
      // signatures instead of prose, so they skip discovery entirely.
      let body = [
        memory.summary ? memory.summary.trim() : "",
        fileList.length ? `Modified: ${fileList.slice(0, 12).join(", ")}${fileList.length > 12 ? "…" : ""}` : "",
      ].filter(Boolean).join("\n");
      try {
        const worktree = task.worktree_path ?? REPO_ROOT;
        // `git status --porcelain` shortens an untracked directory to just
        // its parent (`?? packages/`) so fileList can contain dir entries.
        // Expand any dir into its individual extractable files before
        // handing to the contract extractor. Otherwise a task that creates
        // a whole new dir gets a null contract — the exact case verify hit.
        const expanded = expandFileList(worktree, fileList).slice(0, 20);
        const files = expanded
          .map((p) => {
            try {
              return { path: p, content: readFileSync(join(worktree, p), "utf8") };
            } catch { return null; }
          })
          .filter((f): f is { path: string; content: string } => f !== null);
        // §4.2e — anchor the contract to the commit it was extracted at, and
        // record the signature set it was extracted FROM. Staleness is derived
        // later by recomputing this and comparing; it is never stored as a
        // boolean, because a `stale` flag is wrong the moment anyone rebases.
        const baseSha = gitHeadSha(worktree);
        const contract = extractContract({ taskId, baseSha, files });
        if (contract) {
          try {
            const index = await resolveCodeIndex({ root: worktree });
            const set = await resolveSignatureSet(index, contract.provides.modules);
            contract.signatureHash = set.hash;
            contract.signatureEntries = set.entries;
          } catch (err) {
            // No hash recorded means validity reports `unknown`, never `valid`.
            // Degrading to "cannot tell" is correct; degrading to "fine" is not.
            console.warn(`[knowledge] signature hash failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          // Compact JSON so we don't waste body budget on pretty-print whitespace.
          body = JSON.stringify(contract);
        }
      } catch (err) {
        console.warn(`[knowledge] contract extract failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const ev = appendKnowledge(db, {
          workspaceId: "local",
          projectId: basename(REPO_ROOT) || "local",
          actorKind: "agent",
          actorId: "claude-code",
          actorName: "Claude Code",
          taskId,
          executionId: null,
          type: "artifact_summary",
          scope: `task:${taskId}`,
          subject: `completed · ${task.title}`,
          body,
          paths: fileList,
          confidence: "observed",
          supersedes: null,
        });
        // §J step 3 — resolve sym: edges for the files this task touched.
        // This is the only await in _persistTaskMemory, and it is last: every
        // synchronous DB write above completes inline before control yields,
        // so callers using `void this._persistTaskMemory(...)` still get the
        // event persisted in order. Only the symbol resolution defers.
        await resolveSymbolEdgesFor(db, ev.event);
      } catch (err) {
        console.warn(`[knowledge] artifact_summary event failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      console.warn(`[task-memory] failed to persist memory for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
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

        // Find the next runnable task (dependencies all complete). §4.7 —
        // if the candidate's likelyPaths overlap with any currently-active
        // task's footprint, defer it and try the next-ready one; prevents
        // worktree conflicts on the day the loop learns to parallelise.
        // Import here to avoid a top-level cycle risk.
        const { hasOverlap } = await import("../../core/src/loop/footprint.ts");
        const activePaths = tasks
          .filter((t) => this.active.has(t.id))
          .map((t) => t.likelyPaths ?? []);
        const runnable = tasks.filter(
          (t) => (t.status === "backlog" || t.status === "ready") &&
                 t.dependsOn.every((dep) => doneIds.has(dep)),
        );
        const next = runnable.find(
          (t) => !activePaths.some((paths) => hasOverlap(t.likelyPaths ?? [], paths)),
        ) ?? runnable[0];

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

        this.broadcast(taskId, {
          type: "test_result",
          passed: result.passed,
          exitCode: result.exitCode,
          output: result.output.slice(0, 500),
        });

        // ─── §5.2 Ralph iteration memory ────────────────────────────────
        // On EVERY verify_tests failure — write a compact "what was tried"
        // summary. The next spawn (whether §4.5 auto-restart, human /execute,
        // or a while_not_done loop) reads these back via renderIterationHistory
        // above so the fresh context doesn't repeat the same fix.
        if (!result.passed) {
          const prevMax = (db.query(
            "SELECT MAX(iteration) as n FROM iteration_memories WHERE task_id = ?",
          ).get(taskId) as { n: number | null } | null)?.n ?? 0;
          const nextIter = (prevMax ?? 0) + 1;
          // The git_diff artifact for THIS execution captures what implement
          // just did — usually the smoking gun for why verify failed.
          const gitDiff = (db.query(
            "SELECT content FROM artifacts WHERE task_id = ? AND kind = 'git_diff' ORDER BY created_at DESC LIMIT 1",
          ).get(taskId) as { content: string } | null)?.content ?? null;
          const iterMem = buildIterationMemory({
            taskTitle: task.title,
            iteration: nextIter,
            testOutput: result.output,
            gitDiff,
            exitCode: result.exitCode,
          });
          try {
            db.query(
              `INSERT INTO iteration_memories (id, task_id, iteration, summary, test_output_tail, git_diff_head, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              crypto.randomUUID(), taskId, nextIter,
              iterMem.summary, iterMem.testOutputTail, iterMem.gitDiffHead, finishedAt,
            );
          } catch (err) {
            console.warn(`[iteration-memory] insert failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          // knowledgelayer §4.1 — same failure, event-log form. Feeds the
          // multiplayer governance gate (§4.5): "Sarah tried this 3 days ago
          // and it failed with the same assertion."
          try {
            // `task` is a rowToTask() result, so the field is camelCase and
            // already parsed. Reading the snake_case column name here meant
            // `paths` was ALWAYS [] on every emitted event, which silently
            // disabled the §4.5 governance gate (buildRiskIndex matches on
            // paths) and would have left §J's edge auto-population with
            // nothing to join on. Caught by the Phase 0 two-task E2E.
            const likelyPaths: string[] = (task.likelyPaths ?? []).filter(
              (p): p is string => typeof p === "string" && p.length > 0,
            );
            appendKnowledge(db, {
              workspaceId: "local",
              projectId: basename(REPO_ROOT) || "local",
              actorKind: "agent",
              actorId: "claude-code",
              actorName: "Claude Code",
              taskId,
              executionId,
              type: "failed_attempt",
              scope: "project",
              subject: `iter ${nextIter} · ${task.title} · verify_tests failed (exit ${result.exitCode})`,
              body: iterMem.summary,
              paths: likelyPaths,
              confidence: "observed",
              supersedes: null,
            });
          } catch (err) {
            console.warn(`[knowledge] failed_attempt event failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // ─── §5.1 Loop policy — resolve the effective knobs ─────────────
        // The task can override the escalation threshold + thrash toggle
        // via task.loopPolicy. Nulls fall through to the tddEnabled-based
        // defaults (see packages/core/src/loop/policy.ts).
        const policy = resolveLoopPolicy(task.tddEnabled, task.loopPolicy as PartialLoopPolicy | null);

        // ─── §5.3 Thrash detection ──────────────────────────────────────
        // Before the §4.5 auto-restart kicks in, check whether the failure
        // pattern already looks stuck (repeated identical error, or two
        // implement runs producing zero diff). If so, raise a decision
        // ticket with the history + leave the task blocked. The user
        // decides whether to bump the tier, edit the task, or abort.
        if (!result.passed && policy.escalation.thrashDetection) {
          // Pull the most recent verify_tests + implement executions plus
          // their git_diff sizes so the detector can reason over the pattern.
          const recentRows = db.query(
            `SELECT e.status, e.tdd_phase, e.error_message,
                    (SELECT LENGTH(a.content) FROM artifacts a
                       WHERE a.execution_id = e.id AND a.kind = 'git_diff' LIMIT 1) AS git_diff_length
             FROM executions e
             WHERE e.task_id = ?
             ORDER BY e.started_at DESC
             LIMIT 6`,
          ).all(taskId) as Array<{
            status: string; tdd_phase: string | null; error_message: string | null; git_diff_length: number | null;
          }>;
          const samples: ExecutionSample[] = recentRows.map((r) => ({
            status: r.status,
            tddPhase: r.tdd_phase,
            errorMessage: r.error_message,
            gitDiffLength: r.git_diff_length ?? 0,
          }));
          const verdict = detectThrash(samples);
          if (verdict.thrash) {
            // Raise a decision ticket so the user sees the pattern and steers.
            const ticketId = crypto.randomUUID();
            const context = [
              `Thrash signal: ${verdict.signal}`,
              verdict.reason ?? "",
              "",
              ...(verdict.history ?? []),
            ].filter(Boolean).join("\n");
            try {
              db.query(
                `INSERT INTO decision_tickets (id, task_id, execution_id, question, context, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              ).run(ticketId, taskId, executionId, "The task is thrashing — how should we proceed?", context, finishedAt);
              this.broadcast(taskId, {
                type: "text",
                text: `[thrash] ${verdict.signal} — decision ticket raised, task blocked for human input.`,
              });
            } catch (err) {
              console.warn(`[thrash] failed to insert ticket: ${err instanceof Error ? err.message : String(err)}`);
            }
            // knowledgelayer §4.5 governance-gate substrate — thrash becomes a
            // durable gotcha visible to future runs across all teammates.
            try {
              appendKnowledge(db, {
                workspaceId: "local",
                projectId: basename(REPO_ROOT) || "local",
                actorKind: "agent",
                actorId: "thrash-detector",
                actorName: "agent-trail",
                taskId,
                executionId,
                type: "gotcha",
                scope: "project",
                subject: `thrash on ${task.title} · ${verdict.signal}`,
                body: [verdict.reason, ...(verdict.history ?? [])].filter(Boolean).join("\n"),
                paths: [],
                confidence: "observed",
                supersedes: null,
              });
            } catch (err) {
              console.warn(`[knowledge] thrash gotcha event failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            // Skip §4.5 auto-escalation this time; land blocked as usual.
            db.query(
              "UPDATE tasks SET failed_verify_count = ?, updated_at = ? WHERE id = ?",
            ).run(2, finishedAt, taskId);
          }
        }

        // ─── §4.5 Model-router-v2 escalation ────────────────────────────
        // Two consecutive verify_tests failures on a TDD task → escalate
        // the tier one step (haiku→sonnet→opus), reset the failure counter,
        // reset the phase back to `implement`, and auto-re-run. If we're
        // already at opus, the escalation short-circuits and we fall through
        // to the normal blocked-for-human path.
        // Thrash short-circuits this — if we raised a ticket above the
        // failed_verify_count is already at 2 but we won't touch tier.
        // Re-check via DB so we don't double-count.
        const thrashOpen = !result.passed && !!db.query(
          `SELECT 1 FROM decision_tickets WHERE execution_id = ? AND answer IS NULL LIMIT 1`,
        ).get(executionId);
        if (!result.passed && task.tddEnabled && !thrashOpen) {
          const prevCount = Number(
            (db.query("SELECT failed_verify_count FROM tasks WHERE id = ?").get(taskId) as { failed_verify_count: number } | null)?.failed_verify_count ?? 0,
          );
          const newCount = prevCount + 1;
          if (newCount >= policy.escalation.escalateAfterFailures) {
            const from: ModelTier = (task.modelTier ?? "sonnet") as ModelTier;
            const to = nextTier(from);
            if (to) {
              db.query(
                "UPDATE tasks SET failed_verify_count = 0, model_tier = ?, tdd_phase = 'implement', status = 'in_progress', last_error = NULL, active_form = NULL, updated_at = ? WHERE id = ?",
              ).run(to, finishedAt, taskId);
              this.broadcast(taskId, {
                type: "text",
                text: `[router-v2] tier escalated ${from} → ${to} after ${newCount} failed verify loops`,
              });
              this.broadcast(taskId, { type: "execution_complete", status: "completed", executionId });
              this.closeAll(taskId);
              this.active.delete(taskId);
              // Re-run on next tick so the finally-blocks / drain settle first.
              queueMicrotask(() => {
                void this._run(taskId).catch((err) => console.error(`[router-v2 restart] ${taskId}: ${err}`));
              });
              this._drainQueue();
              return;
            }
            // Already at opus — leave the counter at newCount so a resume+re-run
            // does not immediately escalate again.
            db.query(
              "UPDATE tasks SET failed_verify_count = ?, updated_at = ? WHERE id = ?",
            ).run(newCount, finishedAt, taskId);
          } else {
            // First failure — bump the counter, fall through to normal blocked.
            db.query(
              "UPDATE tasks SET failed_verify_count = ?, updated_at = ? WHERE id = ?",
            ).run(newCount, finishedAt, taskId);
          }
        } else if (result.passed) {
          // Success — reset the counter so future TDD cycles start clean.
          db.query(
            "UPDATE tasks SET failed_verify_count = 0, updated_at = ? WHERE id = ?",
          ).run(finishedAt, taskId);
        }

        const nextStatus = result.passed ? "in_review" : "blocked";
        const lastError = result.passed ? null : `Tests failed (exit ${result.exitCode})`;
        db.query(
          "UPDATE tasks SET status = ?, active_form = NULL, last_error = ?, updated_at = ? WHERE id = ?",
        ).run(nextStatus, lastError, finishedAt, taskId);

        // §D — write the task memory once verify_tests goes green. Downstream
        // DAG tasks will read this on their next spawn (see buildL1Pack above).
        if (result.passed) void this._persistTaskMemory(taskId, finishedAt);

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

      // §D — write the task memory once a non-TDD (implement_only) task
      // reaches in_review. TDD tasks write their memory from the verify_tests
      // handler above so the summary reflects the code that shipped, not just
      // the failing tests written first.
      if (effectiveStatus === "completed" && nextTaskStatus === "in_review") {
        void this._persistTaskMemory(taskId, finishedAt);
      }

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

    // PRD 3.4 — L0 constitution loaded per-execution so mid-run edits to
    // CLAUDE.md / .agent-trail/context/*.md land in the next task without a
    // server restart. Cap enforced inside loadConstitution.
    //
    // knowledgelayer §4.4 seed — augment the file-based constitution with a
    // fold of the event log. Two sources live side-by-side during the
    // transition: users who haven't run `agent-trail knowledge backfill`
    // still get their file-based context; the fold contributes fresh
    // decisions/conventions/gotchas emitted during agent runs. Kept to
    // 2000 chars so it doesn't crowd out the file-based half; a proper
    // three-band prompt with cache breakpoints (§4.4) supersedes both.
    const fileConstitution = loadConstitution(REPO_ROOT).content;
    let foldedText = "";
    try {
      foldedText = foldConstitution(db, { charCap: 2000 }).markdown;
    } catch (err) {
      // FTS/event table absent (fresh install pre-migration) — degrade to file only.
      console.warn(`[knowledge] fold failed, using file-only constitution: ${err instanceof Error ? err.message : String(err)}`);
    }
    const constitutionText = [fileConstitution, foldedText].filter(Boolean).join("\n\n=== team knowledge (event log) ===\n\n");

    // PRD 4.4 — per-task L1 pack. Adds the task's own scope + a
    // short summary of every DAG dependency's memory (if written), plus
    // the top-N most-likely-relevant repo paths from the term-overlap
    // ranker. Strategic context per task instead of dumping the full board
    // history into every prompt.
    const taskText = [task.title, task.description, ...(task.successCriteria ?? [])].join(" ");
    const repoRoot = task.worktreePath || implementationDir || REPO_ROOT;
    let relevantFiles: string[] = [];
    try {
      relevantFiles = rankRelevantFiles(taskText, { root: repoRoot, topN: 8 }).map((f) => f.path);
    } catch {
      relevantFiles = [];
    }
    // §4.4b — pull pending steers for this task and mark them consumed at
    // spawn time so they land in the very next iteration and don't get
    // replayed on future ones.
    const pendingSteers = db.query(
      "SELECT id, kind, text, created_at FROM steering WHERE task_id = ? AND consumed_at IS NULL ORDER BY created_at ASC",
    ).all(taskId) as Array<{ id: string; kind: string; text: string; created_at: string }>;
    if (pendingSteers.length > 0) {
      const stampedAt = new Date().toISOString();
      const consumeStmt = db.prepare("UPDATE steering SET consumed_at = ? WHERE id = ?");
      for (const s of pendingSteers) consumeStmt.run(stampedAt, s.id);
    }

    // §5.2 — read the latest iteration memories for THIS task so the fresh
    // spawn knows what previous attempts tried + failed with. Kept to the 3
    // most recent to bound the pack size.
    const iterRows = db.query(
      "SELECT iteration, summary, test_output_tail, git_diff_head FROM iteration_memories WHERE task_id = ? ORDER BY iteration DESC LIMIT 3",
    ).all(taskId) as Array<{ iteration: number; summary: string; test_output_tail: string | null; git_diff_head: string | null }>;
    const iterationHistory = renderIterationHistory(
      iterRows.map<IterationSample>((r) => ({
        iteration: r.iteration,
        summary: r.summary,
        testOutputTail: r.test_output_tail,
        gitDiffHead: r.git_diff_head,
      })),
    );

    const l1 = buildL1Pack(REPO_ROOT, {
      id: task.id,
      title: task.title,
      description: task.description,
      successCriteria: task.successCriteria,
      dependsOn: task.dependsOn,
    }, {
      relevantFiles,
      steers: pendingSteers.map((s) => ({ kind: s.kind, text: s.text, createdAt: s.created_at })),
      iterationHistory,
    });

    // knowledgelayer §4.5 — auto-precheck (Band D). Every spawn gets a
    // deterministic warning block for prior failed_attempt / gotcha events
    // on the files this task is about to touch. No LLM call; no manual
    // MCP invocation required. Cross-task, cross-teammate.
    let bandD = "";
    try {
      const touchPaths = [...new Set([...(task.likelyPaths ?? []), ...relevantFiles])];
      if (touchPaths.length > 0) {
        const idx = buildRiskIndex(db, touchPaths);
        bandD = formatRiskWarnings(idx);
      }
    } catch (err) {
      console.warn(`[knowledge] precheck at spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // knowledgelayer-v2 §6 — hybrid retrieval over the joined graph.
    //
    // ONE ranked block, seeded two ways: lexically (FTS5 over the log) and
    // structurally (§J edges from this task's file footprint, expanded one hop
    // through the code graph). Previously these rendered as two sections,
    // which meant an event reached both ways was printed twice — spending the
    // budget this layer exists to protect. Merging them also lets a fact found
    // BOTH ways outrank one found either way alone, which is the correct
    // ranking and was not expressible while they were separate.
    //
    // Fail-soft throughout: no adapter degrades Q2 to Q1, no edges degrades to
    // lexical-only, and a total failure degrades to an empty block.
    let relatedBlock = "";
    try {
      const touchPaths = [...new Set([...(task.likelyPaths ?? []), ...relevantFiles])];
      const codeIndex = await resolveCodeIndex({ root: REPO_ROOT });
      const facts = await retrieveForTask(
        db,
        { text: taskText, paths: touchPaths },
        codeIndex,
        { limit: 8, excludeTaskId: task.id },
      );
      const rendered = formatRetrievedFacts(facts);
      if (rendered) relatedBlock = `## Related team knowledge\n\n${rendered}`;
    } catch (err) {
      console.warn(`[knowledge] retrieval at spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // knowledgelayer §4.2b (partial) — DAG dependency handoff via events.
    // Each `dependsOn` task's artifact_summary event is included so the
    // downstream task inherits an exact structured summary — not a fuzzy
    // markdown file. Falls back to file-based memories (still in buildL1Pack
    // above) when no event exists, so nothing regresses.
    let depSummariesBlock = "";
    try {
      const deps = task.dependsOn ?? [];
      if (deps.length > 0) {
        const placeholders = deps.map(() => "?").join(",");
        const rows = db.query(
          `SELECT task_id, subject, body FROM knowledge_events
           WHERE type = 'artifact_summary' AND superseded_by IS NULL
             AND task_id IN (${placeholders})
           ORDER BY id DESC`,
        ).all(...deps) as Array<{ task_id: string; subject: string; body: string }>;
        // Dedupe on task_id — latest artifact_summary per dep wins.
        const seen = new Set<string>();
        const uniq = rows.filter((r) => (seen.has(r.task_id) ? false : (seen.add(r.task_id), true)));
        if (uniq.length > 0) {
          const lines: string[] = ["## Upstream task handoffs", ""];
          for (const r of uniq) {
            lines.push(`### ${r.subject}`);
            // §4.2b — body may be a JSON-encoded capability contract or
            // prose. Try to parse; render the structured form when possible
            // so the downstream task inherits exact signatures instead of a
            // paragraph. Falls back to raw body on parse failure.
            const contract = tryParseContract(r.body);
            if (contract) {
              // §4.2e — validity is a QUERY, answered here at pack time
              // against the working tree, never a flag read off the row.
              // A contract that promises a signature which no longer exists
              // is worse than no contract: the agent will confidently call it.
              let toRender = contract;
              let warning = "";
              try {
                const index = await resolveCodeIndex({ root: REPO_ROOT });
                const report = await checkContractValidity(contract, index);
                warning = formatValidityWarning(report);
                if (report.status === "drifted") {
                  // Re-deriving is one more adapter call, so drift is
                  // recoverable rather than merely detectable. The downstream
                  // task gets today's signatures plus a note about what moved.
                  toRender = await rederiveContract(contract, index, {
                    baseSha: gitHeadSha(REPO_ROOT),
                  });
                }
              } catch (err) {
                console.warn(`[knowledge] validity check failed: ${err instanceof Error ? err.message : String(err)}`);
              }
              if (warning) lines.push(warning);
              lines.push("```");
              lines.push(renderContract(toRender));
              lines.push("```");
            } else {
              lines.push(r.body.trim());
            }
            lines.push("");
          }
          depSummariesBlock = lines.join("\n");
        }
      }
    } catch (err) {
      console.warn(`[knowledge] dep handoff at spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Order (constitution first — team-wide rulings) → (task L1 — this task's
    // scaffolding) → (upstream handoffs — structured summaries of deps) →
    // (related — cross-cutting knowledge) → (Band D — governance warnings).
    // Bands A/B (cacheable) and C/D (per-spawn) will formalize this order
    // with explicit cache breakpoints; this is the same content in the
    // same order.
    // knowledgelayer §4.4 — assemble in BANDS, not one blob.
    //
    // Band B must be byte-identical for every task in this project, so nothing
    // task-derived may enter it. Module briefs are the one judgement call:
    // a brief for the task's own directory is project-stable content, but
    // WHICH brief is task-derived — so including it would break the shared
    // prefix across tasks in different directories. All briefs would be stable
    // but wasteful. We include only the PROJECT_MAP plus the constitution, and
    // let §J retrieval deliver directory-specific knowledge in Band C where it
    // belongs.
    let projectMapBlock = "";
    try {
      const map = projectProjectMap(REPO_ROOT);
      if (map.stack.length || map.topDirs.length) {
        projectMapBlock = `## Project map\n\n${map.markdown.trim()}`;
      }
    } catch (err) {
      console.warn(`[knowledge] project map failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const bandB = [constitutionText, projectMapBlock].filter(Boolean).join("\n\n");
    const bandC = [
      l1.content ? `## Task pack (L1)\n\n${l1.content}` : "",
      depSummariesBlock,
      relatedBlock,
    ].filter(Boolean).join("\n\n");
    const bandDBlock = bandD ? `## Governance warnings (Band D)\n\n${bandD}` : "";

    // Kept for the executions row + the adapter's legacy single-blob path.
    const constitution = [bandB, bandC, bandDBlock].filter(Boolean).join("\n\n");

    // Persist the resolved prompt on the executions row. Gives replay / audit
    // / benchmarking a stable observable (previously null even though the
    // schema had the column). Truncated to 64 KB so a pathological pack can't
    // blow the DB row size — real prompts are ~5-20 KB.
    try {
      db.query("UPDATE executions SET system_prompt = ? WHERE id = ?")
        .run(constitution.slice(0, 64 * 1024), executionId);
    } catch (err) {
      console.warn(`[executions] system_prompt persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const proc = spawnClaudeCode({
      task: taskWithDecision,
      worktreePath,
      mcpConfigPath,
      permissionMode,
      timeoutMs: executionTimeoutMs,
      resumeSessionId: resume?.resumeSessionId,
      constitution,
      // §4.4 — bands win over the blob. Band B carries only project-stable
      // content so two tasks in this project share a byte-identical prefix.
      bands: { project: bandB, task: bandC, governance: bandDBlock },
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
            `UPDATE executions SET duration_ms = ?, total_input_tokens = ?, total_output_tokens = ?,
               cache_read_input_tokens = ?, cache_creation_input_tokens = ?, claude_session_id = ?
             WHERE id = ?`,
          ).run(
            m.durationMs, m.totalInputTokens, m.totalOutputTokens,
            m.cacheReadInputTokens, m.cacheCreationInputTokens,
            result.session_id ?? null, executionId,
          );

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

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// Expand a `git status --porcelain` filelist into individual extractable
// files. Entries with the target extensions pass through. Entries that
// point at a directory (either explicit trailing slash, or verified as a
// dir on disk) are walked recursively — capped at 200 files per dir to
// avoid runaway node_modules-style trees.
function expandFileList(worktree: string, fileList: string[]): string[] {
  const EXTR = /\.(m?[tj]sx?|cts|mts|sql)$/;
  const out: string[] = [];
  for (const raw of fileList) {
    const entry = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    const abs = join(worktree, entry);
    let isDir = false;
    try { isDir = statSync(abs).isDirectory(); } catch { /* missing → skip */ }
    if (isDir) {
      walkDir(abs, entry, out, 200);
    } else if (EXTR.test(entry)) {
      out.push(entry);
    }
  }
  return [...new Set(out)];
}

function walkDir(absDir: string, relPrefix: string, out: string[], budget: number): void {
  if (out.length >= budget) return;
  let entries: string[] = [];
  try { entries = readdirSync(absDir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const abs = join(absDir, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    let s;
    try { s = statSync(abs); } catch { continue; }
    if (s.isDirectory()) {
      walkDir(abs, rel, out, budget);
    } else if (s.isFile() && /\.(m?[tj]sx?|cts|mts|sql)$/.test(name)) {
      out.push(rel);
      if (out.length >= budget) return;
    }
  }
}

function tryParseContract(body: string): CapabilityContract | null {
  const trimmed = body?.trim();
  if (!trimmed?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<CapabilityContract>;
    if (parsed?.type === "capability_contract" && parsed.provides) {
      return parsed as CapabilityContract;
    }
  } catch { /* not a contract — fall through */ }
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
