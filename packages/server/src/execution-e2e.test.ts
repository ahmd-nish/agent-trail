import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD 1.4 — execution engine acceptance:
//   • spawns claude CLI in per-task worktrees   → covered here via implementation_dir; real worktree.create() is unit-tested elsewhere
//   • max 3 parallel                            → covered by packages/server/src/execution-manager.test.ts
//   • SSE live feed                             → asserted here (connects, receives events, closes on complete)
//   • telemetry (tokens, duration, tool calls) persisted → asserted here after a full run

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.once("listening", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") { srv.close(); reject(new Error("no port")); return; }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.listen(0, "127.0.0.1");
  });
}

async function waitForHealth(port: number, ms = 15000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return true;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Scenario: two tool calls + one text block + completion, ~250 in / 90 out.
const HAPPY_SCENARIO = JSON.stringify({
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "Analyzing task requirements..." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Write", input: {} }] } },
    { type: "user",      message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "ok", is_error: false }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "u2", name: "Bash", input: {} }] } },
    { type: "user",      message: { content: [{ type: "tool_result", tool_use_id: "u2", content: "1 pass", is_error: false }] } },
  ],
  final: "complete",
  inputTokens: 250,
  outputTokens: 90,
  durationMs: 42,
  delayMs: 20,
});

interface BoardResp { id: string; name: string }
interface TaskResp  { id: string; status: string }

async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollFor timeout");
}

// Read SSE frames until either the terminal event fires or a timeout hits.
async function collectStreamEvents(url: string, maxMs = 6000): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
          events.push(parsed);
          if (parsed["type"] === "execution_complete" || parsed["type"] === "awaiting_human") {
            ctrl.abort(); // stop reading
          }
        } catch { /* non-JSON */ }
      }
    }
  } catch (err) {
    // AbortError is expected on completion or timeout.
    if ((err as { name?: string }).name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

describe("execution engine E2E — PRD 1.4", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-exec-e2e-"));
    // Give the tasks a real, writable cwd so the execution manager doesn't
    // try to `git worktree add` in a non-git tmp dir.
    workDir = join(tmp, "work"); mkdirSync(workDir, { recursive: true });
    port = await findFreePort();
    const { AGENT_TRAIL_DB_PATH: _a, VIBE_BOARD_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        AGENT_TRAIL_PORT: String(port),
        AGENT_TRAIL_ROOT: tmp,
        AGENT_TRAIL_SKIP_RUNNER: "1",
        AGENT_TRAIL_CLAUDE_MOCK: HAPPY_SCENARIO,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);

    // Create the board and pin implementation_dir so cwd resolution succeeds.
    const boardRes = await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "exec-e2e", implementationDir: workDir }),
    });
    const board = await boardRes.json() as BoardResp;
    boardId = board.id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("execute + SSE stream: task lands in_review, tokens + duration persisted, telemetry logged", async () => {
    // 1. Create a task in implement_only phase (skip TDD gate — that's PRD 1.5).
    const taskRes = await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "happy-path", tddPhase: "implement_only", tddEnabled: false }),
    });
    const task = await taskRes.json() as TaskResp;
    expect(task.status).toBe("backlog");

    // 2. Kick off the execution first. subscribe() short-circuits to "idle"
    //    if no active state exists yet, so we need the execute call to have
    //    registered the run before we open the stream.
    const execRes = await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    expect(execRes.status).toBe(201);
    const { executionId } = await execRes.json() as { executionId: string };
    expect(executionId).toBeString();

    // 3. Now open the SSE stream. The mock adapter drives events via
    //    queueMicrotask + delayMs so we still land inside the run window.
    const streamPromise = collectStreamEvents(`http://localhost:${port}/api/tasks/${task.id}/stream`);

    // 4. Verify the stream carried the shape we expect from the mock scenario.
    const events = await streamPromise;
    const types = events.map((e) => e["type"]);
    expect(types).toContain("connected");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("text");
    expect(types).toContain("execution_complete");

    // 5. Wait for the finalize side-effects to land in SQLite.
    const finalTask = await pollFor(async () => {
      const t = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const row = t.find((r) => r.id === task.id);
      return row?.status === "in_review" ? row : null;
    });
    expect(finalTask.status).toBe("in_review");

    // 6. /api/tasks/:id/executions shows the completed row with tokens + duration.
    const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as Array<{
      id: string;
      status: string;
      total_input_tokens: number | null;
      total_output_tokens: number | null;
      duration_ms: number | null;
      error_message: string | null;
    }>;
    expect(execs.length).toBe(1);
    const exec = execs[0]!;
    expect(exec.status).toBe("completed");
    expect(exec.error_message).toBeNull();
    expect(exec.total_input_tokens).toBe(250);
    expect(exec.total_output_tokens).toBe(90);
    expect(exec.duration_ms).toBe(42);

    // 7. /api/executions/:id/telemetry has per-tool-call rows.
    const tele = await (await fetch(`http://localhost:${port}/api/executions/${executionId}/telemetry`)).json() as Array<{ kind: string; tool_name: string | null }>;
    const kinds = new Set(tele.map((r) => r.kind));
    expect(kinds.has("tool_call")).toBe(true);
    expect(kinds.has("tool_result")).toBe(true);
    // The Write and Bash tool_use rows carry their names.
    const toolNames = new Set(tele.filter((r) => r.kind === "tool_call").map((r) => r.tool_name));
    expect(toolNames.has("Write")).toBe(true);
    expect(toolNames.has("Bash")).toBe(true);
  }, 20000);

  test("stream endpoint returns idle + closes for a task with no active execution", async () => {
    const taskRes = await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "idle-stream" }),
    });
    const task = await taskRes.json() as TaskResp;

    const events = await collectStreamEvents(`http://localhost:${port}/api/tasks/${task.id}/stream`, 3000);
    expect(events.length).toBe(1);
    expect(events[0]!["type"]).toBe("idle");
  });

  test("POST /tasks/:id/stop returns 409 when the task is neither running nor queued", async () => {
    const taskRes = await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "stop-nothing" }),
    });
    const task = await taskRes.json() as TaskResp;

    const res = await fetch(`http://localhost:${port}/api/tasks/${task.id}/stop`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("POST /tasks/:id/execute returns 409 for a task that does not exist", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/00000000-nope/execute`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Task not found");
  });

  test("double-execute returns 409 (task already running / queued)", async () => {
    // Point the mock at a scenario that never terminates on its own within
    // this test's window — we'll stop the task explicitly at the end.
    // Reuse the happy scenario but with a huge delay so it stays busy.
    const slow = JSON.stringify({
      events: [{ type: "assistant", message: { content: [{ type: "text", text: "starting…" }] } }],
      final: "complete", delayMs: 3000,
    });

    // Restart the server just for this test? No — swap the env by writing a
    // sentinel file the mock reads. Simpler: use the ALREADY running server
    // and rely on the scenario's built-in ~100ms delay. The race is small
    // but reliable: after execute → the state.active entry lives until
    // finalize fires, i.e. ~100ms. We hit /execute twice in that window.
    void slow;

    const taskRes = await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "dup-execute", tddPhase: "implement_only" }),
    });
    const task = await taskRes.json() as TaskResp;

    const first = fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    // Fire the second without awaiting the first; both hit the manager
    // before the mock's queueMicrotask+delay+drive chain has finalized.
    const second = await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    expect(second.status).toBe(409);
    const body = await second.json() as { error: string };
    expect(body.error).toMatch(/already (running|queued)/);
    // Drain the first so the task doesn't dangle across tests.
    await first;
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "in_review" ? t : null;
    });
  }, 15000);
});
