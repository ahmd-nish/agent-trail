import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { Database } from "bun:sqlite";

// PRD 1.10 fix (v1-bug-5): on server startup, `recoverFromCrash()` flips
// orphan `running` executions to `failed` and their parent `in_progress`
// tasks to `blocked`.
//
// Strategy: spin the server once so migrations run and the DB has the full
// schema, then kill it, inject an orphan row directly into the DB, then spin
// the server a second time. The recovery should fire during the second boot.

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

async function launchServer(tmp: string): Promise<{ child: ChildProcess; port: number }> {
  const port = await findFreePort();
  const { AGENT_TRAIL_DB_PATH: _a, VIBE_BOARD_DB_PATH: _b, ...cleanEnv } = process.env;
  const child = spawn("bun", [SERVER_ENTRY], {
    cwd: tmp,
    env: {
      ...cleanEnv,
      AGENT_TRAIL_PORT: String(port),
      AGENT_TRAIL_ROOT: tmp,
      AGENT_TRAIL_SKIP_RUNNER: "1",
    },
    stdio: "ignore",
  });
  const up = await waitForHealth(port);
  if (!up) throw new Error(`server did not become ready on ${port}`);
  return { child, port };
}

async function killAndWait(child: ChildProcess): Promise<void> {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
}

interface BoardResp     { id: string; name: string }
interface TaskResp      { id: string; status: string; lastError: string | null }
interface ExecutionRow  { id: string; status: string; error_message: string | null; finished_at: string | null }

describe("server startup crash recovery — PRD 1.10 (v1-bug-5)", () => {
  let tmp = "";
  let dbPath = "";
  let boardId = "";
  let taskId = "";
  let execId = "";
  let secondChild: ChildProcess | undefined;
  let secondPort = 0;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-crash-e2e-"));
    dbPath = join(tmp, "agent-trail.db");

    // Boot 1: let the server run migrations and create a board + task.
    const boot1 = await launchServer(tmp);
    const board = await (await fetch(`http://localhost:${boot1.port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "crash-recovery-board" }),
    })).json() as BoardResp;
    boardId = board.id;
    const task = await (await fetch(`http://localhost:${boot1.port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "in-flight" }),
    })).json() as { id: string };
    taskId = task.id;
    await killAndWait(boot1.child);

    // Inject an orphan directly into the DB file to simulate a crashed run.
    const db = new Database(dbPath);
    execId = `e-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.query(
      "INSERT INTO executions (id, task_id, status, agent_kind, tdd_phase, started_at) VALUES (?, ?, 'running', 'claude-code', 'implement_only', ?)",
    ).run(execId, taskId, now);
    db.query("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, taskId);
    db.close();

    // Boot 2: the recovery should fire during startup.
    const boot2 = await launchServer(tmp);
    secondChild = boot2.child;
    secondPort = boot2.port;
  }, 45000);

  afterAll(async () => {
    if (secondChild) await killAndWait(secondChild);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("orphan `running` execution → `failed` with clear message", async () => {
    const execs = await (await fetch(`http://localhost:${secondPort}/api/tasks/${taskId}/executions`)).json() as ExecutionRow[];
    const orphan = execs.find((e) => e.id === execId);
    expect(orphan).toBeTruthy();
    expect(orphan!.status).toBe("failed");
    expect(orphan!.finished_at).toBeString();
    expect(orphan!.error_message).toContain("Server restarted");
  });

  test("orphan `in_progress` task → `blocked` with retry hint", async () => {
    const tasks = await (await fetch(`http://localhost:${secondPort}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
    const orphaned = tasks.find((t) => t.id === taskId)!;
    expect(orphaned).toBeTruthy();
    expect(orphaned.status).toBe("blocked");
    expect(orphaned.lastError).toContain("Server restarted");
  });
});
