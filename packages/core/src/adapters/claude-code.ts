import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Task, TddPhase, PermissionMode } from "../types/index.ts";
import type { StreamEvent, StreamResultEvent } from "../types/stream-json.ts";
import { resolveModel } from "../planner/models.ts";
import { registerAdapter } from "./agent-adapter.ts";

export interface AdapterCallbacks {
  onEvent(raw: string, parsed: StreamEvent): void;
  onComplete(result: StreamResultEvent): void;
  onError(err: Error): void;
}

const PHASE_INSTRUCTIONS: Record<TddPhase, string> = {
  write_tests: `PHASE: write_tests
Your ONLY job is to write failing tests that define the expected behaviour of this task.
Do NOT implement any production code yet — tests should fail because the implementation does not exist.
Use the project's existing test framework (bun:test if available).`,

  implement: `PHASE: implement
Tests have already been written. Write the minimum production code needed to make them pass.
Do NOT modify existing tests. Run tests after implementing to confirm they pass.`,

  verify_tests: `PHASE: verify_tests
Run the test suite and report results. Do NOT modify any code.
Return exit code 0 only if all tests pass.`,

  implement_only: `PHASE: implement_only
No TDD gate — implement the full solution as described.`,
};

function buildSystemPrompt(task: Task): string {
  const parts = [
    "You are Claude Code executing a task inside an agent-trail pipeline.",
    "",
    PHASE_INSTRUCTIONS[task.tddPhase],
  ];
  if (task.skills.length > 0) {
    parts.push(`\nSuggested skills: ${task.skills.join(", ")}`);
  }
  return parts.join("\n");
}

function buildUserPrompt(task: Task): string {
  const parts = [`Task: ${task.title}`, "", task.description || "(no description)"];

  if (task.successCriteria.length > 0) {
    parts.push("", "## Success Criteria");
    task.successCriteria.forEach((c, i) => parts.push(`${i + 1}. ${c}`));
  }

  if (task.guardrails.length > 0) {
    parts.push("", "## Guardrails (must not violate)");
    const sorted = [...task.guardrails].sort((a, b) => b.priority - a.priority);
    sorted.forEach((g) => parts.push(`[P${g.priority}] ${g.instruction}`));
  }

  if (task.additionalPrompt?.trim()) {
    parts.push("", "## Additional Context", task.additionalPrompt.trim());
  }

  if (task.component) parts.push("", `Component: ${task.component}`);
  if (task.epic) parts.push(`Epic: ${task.epic}`);
  if (task.sprint) parts.push(`Sprint: ${task.sprint}`);

  return parts.join("\n");
}

export interface SpawnOpts {
  task: Task;
  worktreePath: string;
  mcpConfigPath: string | null;
  permissionMode: PermissionMode;
  timeoutMs?: number;
  /** PRD_OPEN_SOURCE 2.2 — when set, invokes `claude --resume <id>` to
   *  continue a prior session (kept alive by the CLI's own store) rather than
   *  starting a fresh one. Falls back to a fresh run if the CLI refuses the id. */
  resumeSessionId?: string;
  callbacks: AdapterCallbacks;
}

export function spawnClaudeCode({ task, worktreePath, mcpConfigPath, permissionMode, timeoutMs, resumeSessionId, callbacks }: SpawnOpts): ChildProcess | null {
  // Test-only escape hatch: when AGENT_TRAIL_CLAUDE_MOCK is set to a JSON
  // scenario, skip spawning a real subprocess and drive the callbacks with
  // scripted events. Lets server-level E2E tests exercise the full pipeline
  // (routes → executionManager → adapter → SSE → telemetry) without a claude
  // CLI or an API key. Ignored in production because nothing sets the var.
  const mock = process.env["AGENT_TRAIL_CLAUDE_MOCK"];
  if (mock) {
    void worktreePath; void mcpConfigPath; void permissionMode; void timeoutMs;
    runMockAdapter(task, mock, callbacks);
    return null;
  }

  if (!Bun.which("claude")) {
    callbacks.onError(
      new Error(
        "claude CLI not found in PATH — install from https://claude.ai/download and authenticate with `claude login`",
      ),
    );
    return null;
  }

  // PRD_OPEN_SOURCE 2.2 — when resuming, drop --no-session-persistence and
  // pass --resume <sessionId>. The CLI will re-hydrate the transcript before
  // continuing from the same context; our prompt appends a "resumed after
  // crash" note upstream in the exec manager.
  const args: string[] = resumeSessionId
    ? [
        "-p",
        buildUserPrompt(task),
        "--output-format", "stream-json",
        "--verbose",
        "--resume", resumeSessionId,
        "--permission-mode", permissionMode,
        "--append-system-prompt", buildSystemPrompt(task),
      ]
    : [
        "-p",
        buildUserPrompt(task),
        "--output-format", "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--permission-mode", permissionMode,
        "--append-system-prompt", buildSystemPrompt(task),
      ];

  const resolvedModel = resolveModel(task.model, task.modelTier);
  if (resolvedModel) {
    args.push("--model", resolvedModel);
  }

  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  // detached: true puts the child into its own process group so the execution
  // manager can kill the whole group (`process.kill(-pid, ...)`) when the user
  // hits Stop — shells, watchers, and grandchildren all go together.
  const proc = spawn("claude", args, {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  let resultReceived = false;
  let timedOut = false;

  // Hard ceiling: if claude hangs (alive but silent), kill the whole process
  // group and surface a "Timed out" error. Cleared on first result event or
  // close — whichever comes first.
  const timeoutHandle =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          if (resultReceived) return;
          timedOut = true;
          const minutes = Math.round(timeoutMs / 60_000);
          try {
            if (proc.pid) process.kill(-proc.pid, "SIGTERM");
          } catch {
            // process already gone — close handler will fire shortly
          }
          callbacks.onError(new Error(`Timed out after ${minutes}m`));
        }, timeoutMs)
      : null;

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as StreamEvent;
      callbacks.onEvent(trimmed, parsed);
      if (parsed.type === "result") {
        resultReceived = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        callbacks.onComplete(parsed as StreamResultEvent);
      }
    } catch {
      // non-JSON line — ignore
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text && !text.startsWith("Warning:")) {
      console.error(`[claude-code:${task.id}] ${text}`);
    }
  });

  proc.on("error", (err) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    callbacks.onError(new Error(`Failed to spawn claude: ${err.message}`));
  });

  proc.on("close", (code, signal) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut) return; // already surfaced via the timeout error
    if (!resultReceived) {
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        callbacks.onError(new Error(`claude was cancelled (signal ${signal})`));
      } else if (code !== 0) {
        callbacks.onError(new Error(`claude exited with code ${code} without emitting a result event`));
      }
    }
  });

  return proc;
}

// ─── Test-only mock adapter ─────────────────────────────────────────────────
//
// Drives the same AdapterCallbacks the real spawn uses, off a JSON scenario
// so tests can script the pipeline. Fires everything on `queueMicrotask` so
// the executionManager's synchronous slot-reservation completes before events
// start arriving (mirrors the real adapter's async stdout stream).
//
// Scenario shape (`AGENT_TRAIL_CLAUDE_MOCK`):
//   {
//     "events": [ { "type": "assistant" | "user", … StreamEvent … }, … ],
//     "final":  "complete" | "error",
//     "errorMessage": string,          // only when final === "error"
//     "inputTokens":  number,          // default 100
//     "outputTokens": number,          // default 40
//     "durationMs":   number,          // default 25
//     "delayMs":      number           // delay between events; default 0
//   }

interface MockScenario {
  events?: StreamEvent[];
  final?: "complete" | "error";
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  delayMs?: number;
}

function runMockAdapter(task: Task, mock: string, callbacks: AdapterCallbacks): void {
  let scenario: MockScenario;
  try {
    scenario = JSON.parse(mock) as MockScenario;
  } catch (err) {
    callbacks.onError(new Error(`AGENT_TRAIL_CLAUDE_MOCK parse error: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  const events = scenario.events ?? [];
  const delay = Math.max(0, scenario.delayMs ?? 0);

  async function drive() {
    for (const ev of events) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      // Ask-human side effect: when the mock fires a tool_use for `ask_human`,
      // mirror what the real MCP server does — insert a decision_tickets row
      // so the execution-manager's post-run cross-check finds it. Keeps the
      // mock faithful without spawning a real MCP process.
      if (ev.type === "assistant") {
        for (const block of ev.message.content) {
          if (block.type === "tool_use" && isAskHumanLike(block.name)) {
            insertMockDecisionTicket(task.id, block);
          }
        }
      }

      try {
        callbacks.onEvent(JSON.stringify(ev), ev);
      } catch (err) {
        // Isolate adapter behavior — a callback throw shouldn't stop the run.
        console.warn(`[claude-mock] onEvent threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (scenario.final === "error") {
      callbacks.onError(new Error(scenario.errorMessage ?? "mock error"));
      return;
    }

    const result: StreamResultEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      api_error_status: null,
      duration_ms: scenario.durationMs ?? 25,
      duration_api_ms: Math.floor((scenario.durationMs ?? 25) / 2),
      num_turns: events.length || 1,
      result: `mock complete for ${task.id}`,
      stop_reason: "end_turn",
      session_id: `mock-session-${task.id}`,
      total_cost_usd: 0,
      usage: {
        input_tokens: scenario.inputTokens ?? 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: scenario.outputTokens ?? 40,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
      permission_denials: [],
      terminal_reason: "end_turn",
      uuid: `mock-${task.id}`,
    };
    callbacks.onComplete(result);
  }

  queueMicrotask(() => { void drive(); });
}

// Mirrors the isAskHumanTool check in execution-manager.ts. Duplicated here
// so the adapter mock has no server import.
function isAskHumanLike(name: string): boolean {
  return name === "ask_human" || name.endsWith("__ask_human");
}

interface AskHumanBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: { question?: string; context?: string };
}

// Insert a decision_tickets row using the same DB the server opened. The
// AGENT_TRAIL_DB_PATH env is set by the plumbing in db.ts's resolveDbPath —
// falls back to <project root>/agent-trail.db which our test drivers already
// point at their tmp dir via AGENT_TRAIL_ROOT + CWD.
function insertMockDecisionTicket(taskId: string, block: AskHumanBlock): void {
  const dbPath =
    process.env["AGENT_TRAIL_DB_PATH"] ??
    process.env["VIBE_BOARD_DB_PATH"] ??
    resolveMockDbPath();
  if (!dbPath) return;
  try {
    // Import lazily so non-Bun runtimes (if this file is ever type-checked
    // against Node) don't blow up. runMockAdapter is only invoked under bun.
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath);
    // Find the most recent running execution for this task; that's the one
    // the current mock spawn is fulfilling.
    const exec = db
      .query("SELECT id FROM executions WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
      .get(taskId) as { id: string } | null;
    if (!exec) { db.close(); return; }
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO decision_tickets (id, task_id, execution_id, question, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      taskId,
      exec.id,
      block.input?.question ?? "mock question",
      block.input?.context ?? null,
      now,
    );
    db.close();
  } catch (err) {
    console.warn(`[claude-mock] insertMockDecisionTicket failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveMockDbPath(): string {
  return `${process.env["AGENT_TRAIL_ROOT"] ?? process.cwd()}/agent-trail.db`;
}

// Register with the shared adapter registry so `Task.assignee = "claude-code"`
// dispatches here at spawn time (PRD_OPEN_SOURCE 2.4).
registerAdapter("claude-code", spawnClaudeCode);
