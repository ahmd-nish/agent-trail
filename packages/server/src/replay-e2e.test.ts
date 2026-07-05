import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE 2.8 — every real run gets an on-disk JSONL replay; the
// GET /api/executions/:id/replay endpoint returns it as JSON the demo
// player can eat unchanged.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const HAPPY_SCENARIO = JSON.stringify({
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "warming up" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Read", input: { file_path: "server.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "1  hello", is_error: false }] } },
  ],
  final: "complete",
  inputTokens: 40, outputTokens: 10, durationMs: 10, delayMs: 5,
});

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

async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollFor timeout");
}

describe("replay recorder E2E — PRD_OPEN_SOURCE 2.8", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";
  let taskId = "";
  let executionId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-replay-e2e-"));
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

    boardId = ((await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "replay-e2e", implementationDir: workDir }),
    })).json()) as { id: string }).id;
    taskId = ((await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "recorded-run", tddEnabled: false, tddPhase: "implement_only" }),
    })).json()) as { id: string }).id;

    executionId = ((await (await fetch(`http://localhost:${port}/api/tasks/${taskId}/execute`, { method: "POST" })).json()) as { executionId: string }).executionId;

    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as Array<{ id: string; status: string }>;
      const t = list.find((r) => r.id === taskId);
      return t?.status === "in_review" ? t : null;
    });
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("GET /api/executions/:id/replay returns the recorded stream", async () => {
    const res = await fetch(`http://localhost:${port}/api/executions/${executionId}/replay`);
    expect(res.status).toBe(200);
    const body = await res.json() as { executionId: string; events: Array<{ ts: number; event: { type: string } }> };
    expect(body.executionId).toBe(executionId);
    // Should include the text + tool_call + tool_result + execution_complete
    const types = new Set(body.events.map((e) => e.event.type));
    expect(types.has("tool_call")).toBe(true);
    expect(types.has("tool_result")).toBe(true);
    expect(types.has("execution_complete")).toBe(true);
    // Timestamps must be monotonically non-decreasing.
    for (let i = 1; i < body.events.length; i++) {
      expect(body.events[i]!.ts).toBeGreaterThanOrEqual(body.events[i-1]!.ts);
    }
  });

  test("unknown execution → 404", async () => {
    const res = await fetch(`http://localhost:${port}/api/executions/does-not-exist/replay`);
    expect(res.status).toBe(404);
  });
});
