import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §C — plan-review + approval gate.
// Rules:
//   • Manual POST /api/boards → auto-approved (existing behavior; the user
//     is manually configuring, no plan review needed).
//   • POST /api/boards/plan → approved_at stays null; execution blocks
//     until POST /api/boards/:id/approve fires.
//   • POST /api/tasks/:id/execute AND /resume both refuse with 403 while
//     approved_at is null. POST /:id/run does too.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const PLANNER_MOCK = JSON.stringify({
  tasks: [
    {
      id: "task-1", title: "Say hello", description: "Print hello",
      priority: "medium", assignee: "claude-code", reviewKind: "none",
      tddEnabled: false, dependsOn: [],
      successCriteria: ["Prints hello"], guardrails: [],
      modelTier: "sonnet",
    },
  ],
});

const CLAUDE_MOCK = JSON.stringify({
  events: [{ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }],
  final: "complete", inputTokens: 10, outputTokens: 5, durationMs: 5,
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
    await new Promise((r) => setTimeout(r, 100));
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

interface Board  { id: string; name: string; approvedAt: string | null }
interface Task   { id: string }

describe("plan-review approval gate — PRD §C", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-approval-e2e-"));
    mkdirSync(join(tmp, ".inventarium"), { recursive: true });
    port = await findFreePort();
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        INVENTARIUM_PORT: String(port),
        INVENTARIUM_ROOT: tmp,
        INVENTARIUM_SKIP_RUNNER: "1",
        INVENTARIUM_SKIP_AUTOSYNC: "1",
        INVENTARIUM_PLANNER_MOCK: PLANNER_MOCK,
        INVENTARIUM_CLAUDE_MOCK: CLAUDE_MOCK,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("manual POST /api/boards auto-approves — existing users are not disrupted", async () => {
    const b = await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "manual-board", implementationDir: tmp }),
    })).json() as Board;
    expect(b.approvedAt).toBeTruthy();
  });

  test("planner-created board leaves approved_at null; execution refuses with 403", async () => {
    const planRes = await fetch(`http://localhost:${port}/api/boards/plan`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prdText: "# Notes API\nBuild a notes API.", name: "gate-board" }),
    });
    expect(planRes.status).toBe(200);
    const plan = await planRes.json() as { board: { id: string; name: string }; tasks: Task[] };
    expect(plan.board).toBeTruthy();

    // Approval-null on the board list.
    const boards = await (await fetch(`http://localhost:${port}/api/boards`)).json() as Board[];
    const gate = boards.find((b) => b.id === plan.board.id)!;
    expect(gate.approvedAt).toBeNull();

    // /execute is blocked.
    const exec = await fetch(`http://localhost:${port}/api/tasks/${plan.tasks[0]!.id}/execute`, { method: "POST" });
    expect(exec.status).toBe(403);
    const err = await exec.json() as { error: string };
    expect(err.error).toContain("approval");

    // /resume is blocked too.
    const resume = await fetch(`http://localhost:${port}/api/tasks/${plan.tasks[0]!.id}/resume`, { method: "POST" });
    expect(resume.status).toBe(403);

    // /run at the board level is blocked.
    const run = await fetch(`http://localhost:${port}/api/boards/${plan.board.id}/run`, { method: "POST" });
    expect(run.status).toBe(403);
  });

  test("POST /api/boards/:id/approve flips the gate; a later /execute succeeds", async () => {
    const plan = await (await fetch(`http://localhost:${port}/api/boards/plan`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prdText: "# X\n", name: "flip-board" }),
    })).json() as { board: { id: string }; tasks: Task[] };

    // Before approval — blocked.
    const before = await fetch(`http://localhost:${port}/api/tasks/${plan.tasks[0]!.id}/execute`, { method: "POST" });
    expect(before.status).toBe(403);

    // Approve.
    const approve = await fetch(`http://localhost:${port}/api/boards/${plan.board.id}/approve`, { method: "POST" });
    expect(approve.status).toBe(200);
    const approved = await approve.json() as Board;
    expect(approved.approvedAt).toBeTruthy();

    // After approval — execution succeeds.
    const after = await fetch(`http://localhost:${port}/api/tasks/${plan.tasks[0]!.id}/execute`, { method: "POST" });
    expect(after.status).toBe(201);
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${plan.board.id}/tasks`)).json() as { id: string; status: string }[];
      const t = list.find((r) => r.id === plan.tasks[0]!.id);
      return t && (t.status === "in_review" || t.status === "done") ? t : null;
    });
  }, 20000);

  test("approve is idempotent — second call is a no-op", async () => {
    const plan = await (await fetch(`http://localhost:${port}/api/boards/plan`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prdText: "# Y\n", name: "idempotent-board" }),
    })).json() as { board: { id: string } };
    const first  = await (await fetch(`http://localhost:${port}/api/boards/${plan.board.id}/approve`, { method: "POST" })).json() as Board;
    const second = await (await fetch(`http://localhost:${port}/api/boards/${plan.board.id}/approve`, { method: "POST" })).json() as Board;
    expect(first.approvedAt).toBe(second.approvedAt);
  });

  test("approve on unknown board → 404", async () => {
    const res = await fetch(`http://localhost:${port}/api/boards/does-not-exist/approve`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
