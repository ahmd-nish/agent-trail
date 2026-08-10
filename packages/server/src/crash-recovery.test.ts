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
  const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
  const child = spawn("bun", [SERVER_ENTRY], {
    cwd: tmp,
    env: {
      ...cleanEnv,
      INVENTARIUM_PORT: String(port),
      INVENTARIUM_ROOT: tmp,
      INVENTARIUM_SKIP_RUNNER: "1",
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
  let strandedTaskId = "";
  let secondChild: ChildProcess | undefined;
  let secondPort = 0;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-crash-e2e-"));
    dbPath = join(tmp, "inventarium.db");

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

    // A task marked in_progress with NO execution row — the board runner queues
    // in memory and only writes the row on spawn, so killing the process in that
    // window strands the task. Reconciliation used to ignore this entirely and
    // real databases accumulated in_progress zombies for months.
    strandedTaskId = `t-${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO tasks (id, board_id, title, status, created_at, updated_at)
       VALUES (?, ?, 'queued when the server died', 'in_progress', ?, ?)`,
    ).run(strandedTaskId, boardId, now, now);
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

  test("a task queued-but-never-started is also recovered, not stranded forever", async () => {
    const tasks = await (await fetch(`http://localhost:${secondPort}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
    const stranded = tasks.find((t) => t.id === strandedTaskId)!;
    expect(stranded).toBeTruthy();
    // Was left `in_progress` forever before this fix — with no execution row,
    // there was nothing for the old reconciler to notice.
    expect(stranded.status).toBe("blocked");
    // And it says it never STARTED, rather than claiming work was lost in flight.
    expect(stranded.lastError).toContain("never started");
  });
});

// The case the combined scenario above CANNOT catch: only stranded tasks, no
// orphaned execution at all. The old reconciler early-returned on
// `orphans.length === 0`, so this boot did nothing and the task stayed
// in_progress forever. Verified to fail when that early return is restored.
describe("crash recovery — stranded queued task with NO orphaned execution", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let boardId = "";
  let strandedId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "inv-stranded-"));
    const boot1 = await launchServer(tmp);
    const board = await (await fetch(`http://localhost:${boot1.port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "stranded-board" }),
    })).json() as { id: string };
    boardId = board.id;
    await killAndWait(boot1.child);

    // in_progress, no execution row anywhere in the database.
    const db = new Database(join(tmp, "inventarium.db"));
    strandedId = `t-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO tasks (id, board_id, title, status, created_at, updated_at)
       VALUES (?, ?, 'stranded on the queue', 'in_progress', ?, ?)`,
    ).run(strandedId, boardId, now, now);
    const live = db.query("SELECT COUNT(*) AS n FROM executions WHERE status IN ('running','pending')").get() as { n: number };
    if (live.n !== 0) throw new Error("fixture invalid: an execution is live, which defeats the point");
    db.close();

    const boot2 = await launchServer(tmp);
    child = boot2.child; port = boot2.port;
  }, 45000);

  afterAll(async () => {
    if (child) await killAndWait(child);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("is reset to blocked even though there was nothing to reconcile", async () => {
    const tasks = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
    const t = tasks.find((x) => x.id === strandedId)!;
    expect(t).toBeTruthy();
    expect(t.status).toBe("blocked");
    expect(t.lastError).toContain("never started");
  });
});
