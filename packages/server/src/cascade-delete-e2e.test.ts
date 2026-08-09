import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { Database } from "bun:sqlite";

// PRD_TESTING T0.6 — deleting a task must cascade-delete its `test_case_runs`
// rows. Migration v10 declares `FOREIGN KEY(task_id) REFERENCES tasks(id) ON
// DELETE CASCADE`, but SQLite requires `PRAGMA foreign_keys = ON` per
// connection to enforce it. This test spawns the real server, seeds a run
// row directly, deletes the task via HTTP, and asserts the run row is gone.

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

interface BoardResp { id: string; name: string }
interface TaskResp  { id: string }

describe("test_case_runs cascade-delete on task delete — T0.6", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-cascade-t0-"));
    port = await findFreePort();
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
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
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("DELETE task removes its child test_case_runs rows via ON DELETE CASCADE", async () => {
    // Set up via HTTP so the server owns the writes.
    const board = await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cascade" }),
    })).json() as BoardResp;

    const task = await (await fetch(`http://localhost:${port}/api/boards/${board.id}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "will-be-deleted" }),
    })).json() as TaskResp;

    // Seed a run row for a hypothetical case id. The row is real and its
    // task_id column carries the FK.
    const dbPath = join(tmp, "inventarium.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const caseId = `case-${crypto.randomUUID()}`;
    const runId  = `run-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO test_case_runs (id, test_case_id, task_id, passed, duration_ms, ran_at)
       VALUES (?, ?, ?, 1, 5, ?)`,
    ).run(runId, caseId, task.id, now);

    // Pre-condition — the seed landed.
    const before = db.query("SELECT COUNT(*) AS n FROM test_case_runs WHERE task_id = ?")
      .get(task.id) as { n: number };
    expect(before.n).toBe(1);
    db.close();

    // Delete the task through the API.
    const del = await fetch(`http://localhost:${port}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // The cascade should have fired — no orphan run rows for the dead task.
    const db2 = new Database(dbPath);
    const after = db2.query("SELECT COUNT(*) AS n FROM test_case_runs WHERE task_id = ?")
      .get(task.id) as { n: number };
    expect(after.n).toBe(0);
    db2.close();
  });
});
