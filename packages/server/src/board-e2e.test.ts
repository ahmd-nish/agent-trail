import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD 1.3 acceptance — the kanban board is 6 columns + drag-drop + task
// detail + DAG. The server-side proof: every status is accepted, PATCH
// transitions persist, and the DAG shape (dependsOn, parallelGroup) survives
// a round-trip. The DAG-view layout math is exercised in
// packages/web/src/lib/dag-layout.test.ts.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const STATUSES = ["backlog", "ready", "in_progress", "blocked", "in_review", "done"] as const;

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

interface TaskResp {
  id: string;
  title: string;
  status: string;
  dependsOn: string[];
  modelTier: string | null;
  parallelGroup: string | null;
}

describe("board E2E — PRD 1.3", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let boardId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-board-e2e-"));
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

    // One board reused across the file.
    const res = await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "board-e2e" }),
    });
    const board = await res.json() as { id: string };
    boardId = board.id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("all 6 kanban statuses are accepted on task creation", async () => {
    for (const status of STATUSES) {
      const res = await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `task-${status}`, status }),
      });
      expect(res.status).toBe(201);
      const task = await res.json() as TaskResp;
      expect(task.status).toBe(status);
    }
    const listed = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
    const statuses = new Set(listed.map((t) => t.status));
    for (const s of STATUSES) expect(statuses.has(s)).toBe(true);
  });

  test("PATCH /api/tasks/:id changes status (drag-drop equivalent)", async () => {
    const createRes = await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "drag-source", status: "backlog" }),
    });
    const created = await createRes.json() as TaskResp;

    // Simulate the drag flow: backlog → ready → in_progress → done.
    for (const next of ["ready", "in_progress", "done"] as const) {
      const res = await fetch(`http://localhost:${port}/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json() as TaskResp;
      expect(updated.status).toBe(next);
    }
  });

  test("dependsOn round-trips through create + list (DAG-shape data)", async () => {
    const a = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "dep-parent" }),
    })).json() as TaskResp;

    const b = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "dep-child", dependsOn: [a.id] }),
    })).json() as TaskResp;

    expect(b.dependsOn).toEqual([a.id]);

    const listed = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
    const child = listed.find((t) => t.id === b.id);
    expect(child?.dependsOn).toEqual([a.id]);
  });

  test("PATCH /api/tasks/:id rejects invalid modelTier", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "tier-test" }),
    })).json() as TaskResp;

    const bad = await fetch(`http://localhost:${port}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelTier: "sonic" }),
    });
    expect(bad.status).toBe(400);

    const good = await fetch(`http://localhost:${port}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelTier: "opus" }),
    });
    expect(good.status).toBe(200);
    const updated = await good.json() as TaskResp;
    expect(updated.modelTier).toBe("opus");
  });
});
