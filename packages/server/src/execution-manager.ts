import { join } from "node:path";
import { getDb, rowToTask } from "./db.ts";
import { spawnClaudeCode } from "../../core/src/adapters/claude-code.ts";
import { runTests } from "../../core/src/adapters/test-runner.ts";
import { WorktreeManager } from "../../core/src/adapters/worktree.ts";
import { McpConfigManager } from "../../core/src/adapters/mcp-config.ts";
import { parseTelemetry, extractMetrics } from "../../core/src/telemetry/parser.ts";
import { capturePostExecutionArtifacts } from "../../core/src/adapters/post-execution.ts";
import type { StreamEvent } from "../../core/src/types/stream-json.ts";

const MAX_CONCURRENT = 3;
const REPO_ROOT = join(import.meta.dir, "../../..");
const DB_PATH = join(REPO_ROOT, "agent-trail.db");
const ASK_HUMAN_SCRIPT = join(REPO_ROOT, "packages/core/src/mcp/ask-human.ts");

interface ExecutionState {
  executionId: string;
  taskId: string;
  subscribers: ReadableStreamDefaultController<Uint8Array>[];
}

class ExecutionManager {
  private active = new Map<string, ExecutionState>();
  private worktrees = new WorktreeManager(REPO_ROOT);
  private mcpConfigs = new McpConfigManager(REPO_ROOT);
  private enc = new TextEncoder();

  get concurrentCount() {
    return this.active.size;
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
  ): Promise<{ executionId: string } | { error: string }> {
    if (this.active.size >= MAX_CONCURRENT) {
      return { error: `Max ${MAX_CONCURRENT} concurrent executions reached` };
    }
    if (this.active.has(taskId)) {
      return { error: "Task already running" };
    }

    const db = getDb();
    const taskRow = db
      .query("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as Parameters<typeof rowToTask>[0] | null;
    if (!taskRow) return { error: "Task not found" };

    const task = rowToTask(taskRow);
    const executionId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.query(
      "INSERT INTO executions (id, task_id, status, agent_kind, tdd_phase, started_at) VALUES (?, ?, 'running', ?, ?, ?)",
    ).run(executionId, taskId, task.assignee, task.tddPhase, now);

    db.query("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, taskId);

    this.active.set(taskId, { executionId, taskId, subscribers: [] });

    // ─── verify_tests: run test suite directly, no Claude ────────────────────
    if (task.tddPhase === "verify_tests") {
      const worktreePath = (await this.worktrees.create(taskId)) ?? REPO_ROOT;
      this.broadcast(taskId, { type: "text", text: "Running test suite…" });

      runTests(worktreePath).then((result) => {
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
        db.query("UPDATE tasks SET status = ?, active_form = NULL, updated_at = ? WHERE id = ?").run(
          nextStatus, finishedAt, taskId,
        );

        this.broadcast(taskId, {
          type: "test_result",
          passed: result.passed,
          exitCode: result.exitCode,
          output: result.output.slice(0, 500),
        });
        this.broadcast(taskId, { type: "execution_complete", status, executionId });
        this.closeAll(taskId);
        this.active.delete(taskId);
      });

      return { executionId };
    }

    // ─── Claude Code execution ────────────────────────────────────────────────
    const worktreePath = (await this.worktrees.create(taskId)) ?? REPO_ROOT;
    const mcpConfigPath = this.mcpConfigs.write(taskId, task.mcps, {
      taskId,
      executionId,
      dbPath: DB_PATH,
      scriptPath: ASK_HUMAN_SCRIPT,
    });

    let seqNum = 0;
    let completionHandled = false;

    const finalize = (status: "completed" | "failed" | "awaiting_human", errorMessage?: string) => {
      if (completionHandled) return;
      completionHandled = true;

      const finishedAt = new Date().toISOString();
      const dbStatus = status === "awaiting_human" ? "awaiting_human" : status;
      db.query(
        "UPDATE executions SET status = ?, finished_at = ?, error_message = ? WHERE id = ?",
      ).run(dbStatus, finishedAt, errorMessage ?? null, executionId);

      const nextTaskStatus =
        status === "completed" ? "in_review"
        : status === "awaiting_human" ? "blocked"
        : "blocked";

      db.query("UPDATE tasks SET status = ?, active_form = NULL, updated_at = ? WHERE id = ?").run(
        nextTaskStatus, finishedAt, taskId,
      );

      const broadcastStatus = status === "awaiting_human" ? "failed" : status;
      this.broadcast(taskId, {
        type: status === "awaiting_human" ? "awaiting_human" : "execution_complete",
        status: broadcastStatus,
        executionId,
      });
      this.closeAll(taskId);
      this.active.delete(taskId);
      this.mcpConfigs.cleanup(taskId);
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

    spawnClaudeCode({
      task: taskWithDecision,
      worktreePath,
      mcpConfigPath,
      callbacks: {
        onEvent: (raw, parsed) => {
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
            "UPDATE executions SET duration_ms = ?, total_input_tokens = ?, total_output_tokens = ? WHERE id = ?",
          ).run(m.durationMs, m.totalInputTokens, m.totalOutputTokens, executionId);

          if (result.result?.includes("AWAITING_HUMAN") || result.result?.includes("PAUSE_EXECUTION")) {
            finalize("awaiting_human");
          } else {
            capturePostExecutionArtifacts(taskId, executionId, worktreePath, db);
            finalize("completed");
          }
        },

        onError: (err) => {
          console.error(`[execution-manager] task ${taskId}:`, err.message);
          finalize("failed", err.message);
        },
      },
    });

    return { executionId };
  }
}

function toUiEvent(event: StreamEvent): object | null {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "tool_use") return { type: "tool_call", tool: block.name };
      if (block.type === "text" && block.text.trim()) {
        return { type: "text", text: block.text.slice(0, 120) };
      }
    }
  }
  if (event.type === "user") {
    const c = event.message.content[0];
    if (c?.type === "tool_result") return { type: "tool_result", isError: c.is_error };
  }
  return null;
}

export const executionManager = new ExecutionManager();
