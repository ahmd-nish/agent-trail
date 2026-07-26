import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §5.2 (Ralph memory reaches next spawn) + §5.5 (loop metrics).
// One suite that fails on run 1 (writes iteration_memories row), then a
// second execute call whose SYSTEM_PROMPT_ECHO includes the iteration
// history. Then hits the loop-metrics endpoint and checks totals.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const ECHO_MOCK = JSON.stringify({
  echoSystemPrompt: true,
  events: [{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }],
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
async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollFor timeout");
}

interface BoardResp { id: string }
interface TaskResp  { id: string; status: string }
interface Metrics   {
  perTask: Array<{ taskId: string; iterationsRecorded: number; verifyFailures: number }>;
  aggregates: { iterationsTotal: number; totalTasks: number };
}

describe("Ralph iteration memory + loop metrics — PRD §5.2 + §5.5", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";
  let dbPath = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-ralph-metrics-"));
    workDir = join(tmp, "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "package.json"), JSON.stringify({
      name: "ralph", type: "module", scripts: { test: "bun test" },
    }), "utf-8");
    writeFileSync(join(workDir, "boom.test.ts"),
      `import { test, expect } from "bun:test";\ntest("red 1", () => { expect("apple").toBe("orange"); });\n`,
      "utf-8",
    );
    dbPath = join(tmp, "agent-trail.db");
    port = await findFreePort();
    const { AGENT_TRAIL_DB_PATH: _a, VIBE_BOARD_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        AGENT_TRAIL_PORT: String(port),
        AGENT_TRAIL_ROOT: tmp,
        AGENT_TRAIL_SKIP_RUNNER: "1",
        AGENT_TRAIL_SKIP_AUTOSYNC: "1",
        AGENT_TRAIL_CLAUDE_MOCK: ECHO_MOCK,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
    boardId = (await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ralph", implementationDir: workDir }),
    })).json() as BoardResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("verify_tests failure writes an iteration_memories row + a subsequent implement spawn sees the history", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "iterate-me", tddEnabled: true, tddPhase: "verify_tests",
        modelTier: "sonnet",
        // Disable thrash so §5.2's re-run isn't blocked by an unrelated
        // pattern-match. Escalation threshold set high so §4.5 doesn't
        // fire either — we want a plain "verify fails once → memory written".
        loopPolicy: { escalation: { escalateAfterFailures: 99, thrashDetection: false } },
      }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });

    // Iteration memory row exists.
    const db = new Database(dbPath, { readonly: true });
    const iters = db.query(
      "SELECT summary FROM iteration_memories WHERE task_id = ?",
    ).all(task.id) as { summary: string }[];
    db.close();
    expect(iters.length).toBeGreaterThanOrEqual(1);
    expect(iters[0]!.summary).toContain("iterate-me");
    expect(iters[0]!.summary).toContain("failed");

    // Fire a second execute (still verify_tests since we blocked). The mock
    // adapter echoes the system prompt back through telemetry_events; the
    // "Prior iterations (Ralph memory)" section should appear.
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      // With policy set to escalateAfterFailures=99, the 2nd failure also lands blocked.
      return t?.status === "blocked" ? t : null;
    });

    // verify_tests doesn't spawn claude so there's no SYSTEM_PROMPT_ECHO from it
    // — but re-running via /execute goes through the claude branch when the
    // phase isn't verify_tests. Our task is stuck at verify_tests, so no echo.
    // Instead confirm the L1 pack works by checking a fresh implement_only task
    // whose spawn WILL echo, with a manually-inserted iteration memory
    // (proving the read path).
    const manualTask = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "manual-echo", tddEnabled: false, tddPhase: "implement_only",
      }),
    })).json() as TaskResp;

    // Manually insert an iteration_memory for this task via the DB (we don't
    // expose a write endpoint — production writes come from the verify path).
    const rw = new Database(dbPath);
    rw.query(
      `INSERT INTO iteration_memories (id, task_id, iteration, summary, test_output_tail, git_diff_head, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(), manualTask.id, 1,
      "Iteration 1 of \"manual-echo\" failed — error: TypeError: bad thing", null, null,
      new Date().toISOString(),
    );
    rw.close();

    await fetch(`http://localhost:${port}/api/tasks/${manualTask.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === manualTask.id);
      return t?.status === "in_review" ? t : null;
    });

    const rdb = new Database(dbPath, { readonly: true });
    const rows = rdb.query(
      "SELECT text_content FROM telemetry_events WHERE task_id = ? AND text_content LIKE 'SYSTEM_PROMPT_ECHO:%'",
    ).all(manualTask.id) as { text_content: string }[];
    rdb.close();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.text_content).toContain("Prior iterations (Ralph memory)");
    expect(rows[0]!.text_content).toContain("TypeError: bad thing");
  }, 45000);

  test("§5.5 — /loop-metrics returns per-task iterations + board aggregates", async () => {
    const res = await fetch(`http://localhost:${port}/api/boards/${boardId}/loop-metrics`);
    expect(res.status).toBe(200);
    const m = await res.json() as Metrics;
    expect(m.aggregates.totalTasks).toBeGreaterThanOrEqual(2);
    expect(m.aggregates.iterationsTotal).toBeGreaterThanOrEqual(1);
    // The Ralph task above has at least one verify_tests failure.
    const ralphed = m.perTask.find((p) => p.iterationsRecorded > 0);
    expect(ralphed).toBeDefined();
  });
});
