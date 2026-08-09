import { describe, expect, it, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Database } from "bun:sqlite";

// ─── Test setup ──────────────────────────────────────────────────────────────
//
// Point the execution manager at a throwaway DB file and stub the Claude
// adapter so no real `claude` CLI runs. We also stub the worktree manager
// (avoid `git worktree add`) and post-execution hook (avoid `git diff`).

const tmp = mkdtempSync(join(tmpdir(), "inventarium-test-"));
const dbPath = join(tmp, "test.db");
process.env["INVENTARIUM_DB_PATH"] = dbPath;

// Controllable fake child for stop() tests.
interface FakeChild extends EventEmitter {
  pid: number;
  kill: (sig?: NodeJS.Signals) => boolean;
  killed: boolean;
}
function makeFakeChild(pid = 99999): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = pid;
  ee.killed = false;
  ee.kill = (_sig?: NodeJS.Signals) => {
    ee.killed = true;
    queueMicrotask(() => ee.emit("close", null, "SIGTERM"));
    return true;
  };
  return ee;
}

// Each spawn pushes its callbacks onto a queue tests can poke.
type AdapterCallbacks = {
  onEvent: (raw: string, event: unknown) => void;
  onComplete: (result: unknown) => void;
  onError: (err: Error) => void;
};
type SpawnCall = { taskId: string; callbacks: AdapterCallbacks; child: FakeChild };
const spawnCalls: SpawnCall[] = [];

// mock.module matches by resolved absolute path. Compute paths relative to
// THIS file so the test stays portable; execution-manager imports the same
// modules and ends up at the same absolute paths.
const CORE_ADAPTERS = join(import.meta.dir, "../../core/src/adapters");

mock.module(join(CORE_ADAPTERS, "claude-code.ts"), () => ({
  spawnClaudeCode: (opts: { task: { id: string }; callbacks: AdapterCallbacks }) => {
    const child = makeFakeChild();
    spawnCalls.push({ taskId: opts.task.id, callbacks: opts.callbacks, child });
    // Mirror the real adapter's behavior: a `close` event with SIGTERM/SIGKILL
    // before a `result` event is treated as a cancellation and surfaces as
    // onError, which drives execution-manager.finalize("failed", ...).
    child.on("close", (_code: number | null, signal: string | null) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        opts.callbacks.onError(new Error(`claude was cancelled (signal ${signal})`));
      }
    });
    return child;
  },
}));

// Avoid filesystem side effects from worktree + post-execution.
mock.module(join(CORE_ADAPTERS, "worktree.ts"), () => ({
  WorktreeManager: class {
    constructor(_root: string) {}
    async create(_taskId: string): Promise<string | null> {
      return tmp;
    }
  },
}));
mock.module(join(CORE_ADAPTERS, "post-execution.ts"), () => ({
  capturePostExecutionArtifacts: () => {},
}));
mock.module(join(CORE_ADAPTERS, "mcp-config.ts"), () => ({
  McpConfigManager: class {
    constructor(_root: string) {}
    write(_taskId: string, _mcps: string[], _opts: unknown): string {
      return join(tmp, "mcp.json");
    }
    cleanup(_taskId: string): void {}
  },
}));

// Dynamic import AFTER mocks are registered so the real modules never load.
let executionManager: typeof import("./execution-manager.ts").executionManager;
let getDb: typeof import("./db.ts").getDb;

beforeAll(async () => {
  ({ executionManager } = await import("./execution-manager.ts"));
  ({ getDb } = await import("./db.ts"));
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function seedBoardAndTasks(count: number, opts: { tddPhase?: string } = {}): string[] {
  const db = getDb();
  const boardId = `b-${crypto.randomUUID()}`;
  db.query("INSERT INTO boards (id, name) VALUES (?, ?)").run(boardId, `Board ${boardId}`);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `t-${crypto.randomUUID()}`;
    ids.push(id);
    db.query(
      `INSERT INTO tasks (id, board_id, title, tdd_phase, status) VALUES (?, ?, ?, ?, 'ready')`,
    ).run(id, boardId, `Task ${i}`, opts.tddPhase ?? "implement_only");
  }
  return ids;
}

function fakeResultEvent() {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    session_id: "s",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    },
    permission_denials: [],
    terminal_reason: "x",
    uuid: "u",
  };
}

function getTaskStatus(taskId: string): string {
  const row = getDb().query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
  return row.status;
}

beforeEach(() => {
  // Wipe DB between tests so concurrency counts are predictable.
  const db = getDb();
  db.exec("DELETE FROM telemetry_events");
  db.exec("DELETE FROM artifacts");
  db.exec("DELETE FROM decision_tickets");
  db.exec("DELETE FROM executions");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM boards");
  spawnCalls.length = 0;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("execution manager — concurrency + queue", () => {
  it("MAX_CONCURRENT caps active spawns; extras queue and drain in FIFO order", async () => {
    const ids = seedBoardAndTasks(5);

    // Fire all 5 starts; first 3 should spawn synchronously, last 2 queue.
    const promises = ids.map((id) => executionManager.start(id));
    // start() returns synchronously when slots are free, so let the microtask
    // queue settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(spawnCalls.length).toBe(3);
    expect(executionManager.concurrentCount).toBe(3);
    expect(executionManager.queuedCount).toBe(2);

    // Complete the first 3, one at a time, and verify the queue drains.
    for (let i = 0; i < 3; i++) {
      const call = spawnCalls[i]!;
      call.callbacks.onComplete(fakeResultEvent());
      // Let finalize → drainQueue → next spawn run.
      await new Promise((r) => setTimeout(r, 0));
    }

    // Two more spawns should have fired by now.
    expect(spawnCalls.length).toBe(5);
    // Drain the remaining two so the manager is idle for the next test.
    for (let i = 3; i < 5; i++) spawnCalls[i]!.callbacks.onComplete(fakeResultEvent());
    await Promise.all(promises);
    await new Promise((r) => setTimeout(r, 0));

    expect(executionManager.concurrentCount).toBe(0);
    expect(executionManager.queuedCount).toBe(0);
    for (const id of ids) expect(getTaskStatus(id)).toBe("in_review");
  });
});

describe("execution manager — happy path", () => {
  it("a successful run lands the task in `in_review` with a completed execution row", async () => {
    const [taskId] = seedBoardAndTasks(1);
    await executionManager.start(taskId!);
    await new Promise((r) => setTimeout(r, 0));

    const call = spawnCalls.at(-1)!;
    call.callbacks.onComplete(fakeResultEvent());
    await new Promise((r) => setTimeout(r, 0));

    expect(getTaskStatus(taskId!)).toBe("in_review");
    const exec = getDb()
      .query("SELECT status, error_message FROM executions WHERE task_id = ?")
      .get(taskId!) as { status: string; error_message: string | null };
    expect(exec.status).toBe("completed");
    expect(exec.error_message).toBeNull();
  });
});

describe("execution manager — stop()", () => {
  it("dequeues a queued task and resolves its waiting promise with an error", async () => {
    const ids = seedBoardAndTasks(5);
    const promises = ids.map((id) => executionManager.start(id));
    await new Promise((r) => setTimeout(r, 0));

    expect(executionManager.queuedCount).toBe(2);

    const queuedId = ids[4]!;
    const stopResult = await executionManager.stop(queuedId);
    expect(stopResult.ok).toBe(true);

    // The waiting start() promise should resolve with an error.
    const result = await promises[4]!;
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("Cancelled");

    // Drain the 3 active runs. After each completes, the queue drains one
    // more spawn (ids[3] was queued). Complete those too.
    // Track which spawns have already been completed to avoid double-calling.
    const completed = new Set<number>();
    const drainNew = async () => {
      await new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < spawnCalls.length; i++) {
        if (!completed.has(i)) {
          completed.add(i);
          spawnCalls[i]!.callbacks.onComplete(fakeResultEvent());
        }
      }
      await new Promise((r) => setTimeout(r, 0));
    };
    await drainNew(); // completes the 3 active; ids[3] spawns from queue
    await drainNew(); // completes ids[3]
    await Promise.allSettled(promises);
    await new Promise((r) => setTimeout(r, 0));
  });

  it("kills an active child and marks the task blocked with `Cancelled by user`", async () => {
    const [taskId] = seedBoardAndTasks(1);
    await executionManager.start(taskId!);
    await new Promise((r) => setTimeout(r, 0));

    const call = spawnCalls[0]!;
    expect(call.child.killed).toBe(false);

    await executionManager.stop(taskId!);
    // The fake child emits `close` with SIGTERM on kill, which triggers the
    // adapter's onError → finalize("failed", "claude was cancelled…").
    // finalize sees state.cancelled === true and overrides the message.
    await new Promise((r) => setTimeout(r, 5));

    expect(call.child.killed).toBe(true);
    expect(getTaskStatus(taskId!)).toBe("blocked");
    const exec = getDb()
      .query("SELECT status, error_message FROM executions WHERE task_id = ?")
      .get(taskId!) as { status: string; error_message: string | null };
    expect(exec.status).toBe("failed");
    expect(exec.error_message).toBe("Cancelled by user");
  });

  it("returns ok:false when asked to stop a task that is neither running nor queued", async () => {
    const result = await executionManager.stop("nonexistent-task");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
