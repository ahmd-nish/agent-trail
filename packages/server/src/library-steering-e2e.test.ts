import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §4.1 + §4.2 (library) and §4.4b (steering) — HTTP surface E2E.
// Also verifies that a pending steer lands in the SYSTEM_PROMPT_ECHO on the
// next execution + gets marked consumed_at.

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
interface LibEntry  { name: string; description: string; source: string | null; path: string }
interface SteerRow  { id: string; text: string; consumedAt: string | null; kind: string }

describe("library + steering — PRD §4.1/§4.2/§4.4b E2E", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";
  let dbPath = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-lib-steer-e2e-"));
    workDir = join(tmp, "work");
    mkdirSync(workDir, { recursive: true });
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
      body: JSON.stringify({ name: "lib-steer", implementationDir: workDir }),
    })).json() as BoardResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("POST /api/library with { markdown } saves an entry that GET /api/library returns", async () => {
    const md = `---\nname: sql-linter\ndescription: audits SQL for foot-guns\ntags: sql\n---\n# body\n`;
    const create = await fetch(`http://localhost:${port}/api/library`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: md }),
    });
    expect(create.status).toBe(201);
    const list = await (await fetch(`http://localhost:${port}/api/library`)).json() as LibEntry[];
    expect(list.find((e) => e.name === "sql-linter")).toBeDefined();
    const one = await (await fetch(`http://localhost:${port}/api/library/sql-linter`)).json() as LibEntry;
    expect(one.description).toContain("audits SQL");
  });

  test("POST /api/library with { name, description } scaffolds a stub", async () => {
    const create = await fetch(`http://localhost:${port}/api/library`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "scaffolded", description: "made from scratch" }),
    });
    expect(create.status).toBe(201);
    const body = await create.json() as LibEntry;
    expect(body.name).toBe("scaffolded");
    const one = await (await fetch(`http://localhost:${port}/api/library/scaffolded`)).json() as (LibEntry & { body: string });
    expect(one.body).toContain("TODO");
  });

  test("DELETE /api/library/:name removes the entry", async () => {
    const del = await fetch(`http://localhost:${port}/api/library/scaffolded`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const gone = await fetch(`http://localhost:${port}/api/library/scaffolded`);
    expect(gone.status).toBe(404);
  });

  test("§4.4b — a pending steer lands in the system prompt AND gets marked consumed", async () => {
    // Task to attach steers to.
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "steer-me", tddEnabled: false, tddPhase: "implement_only",
      }),
    })).json() as TaskResp;

    // Drop two steers BEFORE executing.
    const s1 = await fetch(`http://localhost:${port}/api/tasks/${task.id}/steer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "note", text: "use SQLite, not Postgres, for this MVP" }),
    });
    expect(s1.status).toBe(201);
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/steer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "convention", text: "reviewer must be tagged before merge" }),
    });

    const pendingBefore = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/steer`)).json() as SteerRow[];
    expect(pendingBefore.length).toBe(2);
    for (const s of pendingBefore) expect(s.consumedAt).toBeNull();

    // Execute — the two steers should land in the system prompt.
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "in_review" ? t : null;
    });

    // Prompt echo carries the steer text.
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query(
      "SELECT text_content FROM telemetry_events WHERE task_id = ? AND text_content LIKE 'SYSTEM_PROMPT_ECHO:%'",
    ).all(task.id) as { text_content: string }[];
    db.close();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const prompt = rows[0]!.text_content;
    expect(prompt).toContain("New guidance from the user (steering queue)");
    expect(prompt).toContain("use SQLite, not Postgres");
    expect(prompt).toContain("reviewer must be tagged");

    // Steers marked consumed — a re-run shouldn't replay them.
    const pendingAfter = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/steer`)).json() as SteerRow[];
    expect(pendingAfter.length).toBe(0);
    const all = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/steer?includeConsumed=1`)).json() as SteerRow[];
    expect(all.length).toBe(2);
    for (const s of all) expect(s.consumedAt).toBeTruthy();
  }, 30000);
});
