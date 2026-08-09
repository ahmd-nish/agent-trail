import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { nextTddPhase } from "./execution-manager.ts";

// PRD 1.5 — TDD gate.
// Acceptance:
//   • write_tests → implement → verify_tests transitions happen automatically
//   • task cannot close with failing tests (verify_tests fail lands `blocked`)
//   • jest/pytest/bun:test are auto-detected (covered in test-runner.test.ts;
//     here we assert the auto-detection through the real /api/tasks/:id/test path)

describe("nextTddPhase (unit)", () => {
  test("write_tests advances to implement", () => {
    expect(nextTddPhase("write_tests")).toBe("implement");
  });
  test("implement advances to verify_tests", () => {
    expect(nextTddPhase("implement")).toBe("verify_tests");
  });
  test("verify_tests is terminal", () => {
    expect(nextTddPhase("verify_tests")).toBeNull();
  });
  test("implement_only bypasses the gate — no next phase", () => {
    expect(nextTddPhase("implement_only")).toBeNull();
  });
});

// ─── E2E ─────────────────────────────────────────────────────────────────────

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

async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollFor timeout");
}

const PASSING_SCENARIO = JSON.stringify({
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "phase work…" }] } },
  ],
  final: "complete",
  inputTokens: 50, outputTokens: 20, durationMs: 5, delayMs: 0,
});

interface BoardResp { id: string; name: string }
interface TaskResp  { id: string; status: string; tddPhase: string; lastError: string | null; tddEnabled: boolean }

function seedPassingWorkDir(root: string): string {
  const dir = join(root, "pass-work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "tdd-pass",
    type: "module",
    scripts: { test: "bun test" },
  }), "utf-8");
  writeFileSync(join(dir, "sanity.test.ts"), `
    import { describe, test, expect } from "bun:test";
    describe("tdd-gate sanity", () => {
      test("1 + 1 = 2", () => { expect(1 + 1).toBe(2); });
    });
  `, "utf-8");
  return dir;
}

function seedFailingWorkDir(root: string): string {
  const dir = join(root, "fail-work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "tdd-fail",
    type: "module",
    scripts: { test: "bun test" },
  }), "utf-8");
  writeFileSync(join(dir, "boom.test.ts"), `
    import { describe, test, expect } from "bun:test";
    describe("tdd-gate boom", () => {
      test("intentionally red", () => { expect(1).toBe(2); });
    });
  `, "utf-8");
  return dir;
}

describe("TDD gate E2E", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let passBoardId = "";
  let failBoardId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-tdd-e2e-"));
    const passDir = seedPassingWorkDir(tmp);
    const failDir = seedFailingWorkDir(tmp);
    port = await findFreePort();
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        INVENTARIUM_PORT: String(port),
        INVENTARIUM_ROOT: tmp,
        INVENTARIUM_SKIP_RUNNER: "1",
        INVENTARIUM_CLAUDE_MOCK: PASSING_SCENARIO,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);

    // One board per fixture — different implementation_dir on each so the
    // verify_tests phase runs the right suite.
    passBoardId = (await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tdd-pass-board", implementationDir: passDir }),
    })).json() as BoardResp).id;
    failBoardId = (await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tdd-fail-board", implementationDir: failDir }),
    })).json() as BoardResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("full gate: write_tests → implement → verify_tests → in_review (passing suite)", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${passBoardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "tdd-happy",
        tddEnabled: true,
        tddPhase: "write_tests",
      }),
    })).json() as TaskResp;
    expect(task.tddPhase).toBe("write_tests");
    expect(task.tddEnabled).toBe(true);

    const execRes = await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    expect(execRes.status).toBe(201);

    // Wait for the whole gate to run through. Terminal for a TDD-enabled
    // task with a passing suite = in_review + phase verify_tests.
    const final = await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${passBoardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      if (t?.status === "in_review" || t?.status === "blocked") return t;
      return null;
    });
    expect(final.status).toBe("in_review");
    expect(final.tddPhase).toBe("verify_tests");
    expect(final.lastError).toBeNull();

    // Three execution rows should exist — one per phase.
    const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as Array<{
      status: string; tdd_phase: string | null;
    }>;
    expect(execs.length).toBe(3);
    const phases = new Set(execs.map((e) => e.tdd_phase));
    expect(phases.has("write_tests")).toBe(true);
    expect(phases.has("implement")).toBe(true);
    expect(phases.has("verify_tests")).toBe(true);
    for (const e of execs) expect(e.status).toBe("completed");
  }, 30000);

  test("failing suite: task lands in `blocked` with last_error (cannot close with failing tests)", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${failBoardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "tdd-red",
        tddEnabled: true,
        tddPhase: "write_tests",
      }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });

    const final = await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${failBoardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      if (t?.status === "in_review" || t?.status === "blocked") return t;
      return null;
    });
    expect(final.status).toBe("blocked");
    expect(final.tddPhase).toBe("verify_tests");
    expect(final.lastError).toBeTruthy();
    expect(final.lastError!.toLowerCase()).toMatch(/test|failed/);
  }, 30000);

  test("TDD disabled (implement_only) → single-shot, no phase advance", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${passBoardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "tdd-off",
        tddEnabled: false,
        tddPhase: "implement_only",
      }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });

    const final = await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${passBoardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      if (t?.status === "in_review" || t?.status === "blocked") return t;
      return null;
    });
    expect(final.status).toBe("in_review");
    expect(final.tddPhase).toBe("implement_only");

    // Exactly one execution row — no auto-advance re-runs.
    const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as unknown[];
    expect(execs.length).toBe(1);
  }, 15000);

  test("POST /api/tasks/:id/test auto-detects bun:test and returns pass counts", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${passBoardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "runner-detect" }),
    })).json() as TaskResp;

    const res = await fetch(`http://localhost:${port}/api/tasks/${task.id}/test`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      passed: boolean; runner: string;
      passCount: number; failCount: number; executedCount: number; ranSomething: boolean;
    };
    // Task has no worktree; falls back to board.implementation_dir (passDir).
    expect(body.runner).toBe("bun");
    expect(body.passed).toBe(true);
    expect(body.passCount).toBeGreaterThan(0);
    expect(body.failCount).toBe(0);
    expect(body.ranSomething).toBe(true);
  }, 15000);
});
