import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE 2.3 — per-board cost / token cap trips a decision ticket
// and leaves the task in `blocked` (awaiting_human). Verified end-to-end via
// a mocked adapter that emits a big usage number.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

// Scenario: a single assistant turn that reports 500K input tokens. With
// SONNET pricing (3/M in) that's $1.50 — trips a $1 cap instantly.
const BIG_TURN_SCENARIO = JSON.stringify({
  events: [{
    type: "assistant",
    message: {
      content: [{ type: "text", text: "big turn" }],
      usage: { input_tokens: 500_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }],
  final: "complete",
  inputTokens: 500_000, outputTokens: 0, durationMs: 5, delayMs: 5,
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

async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 12000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollFor timeout");
}

interface BoardResp { id: string; executionCostCapUsd: number }
interface TaskResp  { id: string; status: string }

describe("cost-budget cap E2E — PRD_OPEN_SOURCE 2.3", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-budget-e2e-"));
    workDir = join(tmp, "work"); mkdirSync(workDir, { recursive: true });
    port = await findFreePort();
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        INVENTARIUM_PORT: String(port),
        INVENTARIUM_ROOT: tmp,
        INVENTARIUM_SKIP_RUNNER: "1",
        INVENTARIUM_CLAUDE_MOCK: BIG_TURN_SCENARIO,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}\n${stderr}`);

    // Create a board + set the $1 cap.
    boardId = ((await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "budget-e2e", implementationDir: workDir }),
    })).json()) as BoardResp).id;
    const patched = await fetch(`http://localhost:${port}/api/boards/${boardId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executionCostCapUsd: 1.0 }),
    });
    expect(patched.status).toBe(200);
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("execution that blows the cap → task lands `blocked` with a decision ticket", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "over-budget", tddEnabled: false, tddPhase: "implement_only" }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });

    // A ticket citing "Budget cap" should have been written.
    const tickets = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/decisions`)).json() as Array<{ question: string; context: string }>;
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets[0]!.question).toContain("Budget");
    expect(tickets[0]!.context).toMatch(/cap|Cost|Token/i);
  }, 20000);

  test("board with no cap (0) does NOT trip", async () => {
    const openBoard = ((await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-cap", implementationDir: workDir }),
    })).json()) as BoardResp).id;

    const task = await (await fetch(`http://localhost:${port}/api/boards/${openBoard}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "no-cap", tddEnabled: false, tddPhase: "implement_only" }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${openBoard}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "in_review" ? t : null;
    });
    const tickets = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/decisions`)).json() as unknown[];
    expect(tickets.length).toBe(0);
  }, 20000);

  test("PATCH executionCostCapUsd: negative → 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/boards/${boardId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executionCostCapUsd: -1 }),
    });
    expect(res.status).toBe(400);
  });
});
