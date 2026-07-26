import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §4.4 (§D slice) — context orchestrator MVP.
//
// Rules asserted here:
//   1. After a task's terminal success, .agent-trail/context/memories/<taskId>.md
//      lands with a heuristic summary.
//   2. A downstream DAG task picking up the same board sees the dependency's
//      summary inside its own system prompt — proven by the mock's
//      `SYSTEM_PROMPT_ECHO:` telemetry event.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const ECHO_SCENARIO = JSON.stringify({
  echoSystemPrompt: true,
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
  ],
  final: "complete",
  inputTokens: 10, outputTokens: 5, durationMs: 5,
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

interface BoardResp { id: string; name: string }
interface TaskResp  { id: string; status: string }

describe("context orchestrator — PRD §4.4 (§D slice)", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";
  let dbPath = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-ctx-orch-"));
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
        AGENT_TRAIL_CLAUDE_MOCK: ECHO_SCENARIO,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);

    // Manual boards are auto-approved (§C), so we don't need to hit /approve
    // for the test to be able to /execute tasks.
    boardId = (await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ctx-orch", implementationDir: workDir }),
    })).json() as BoardResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("finishing a task writes .agent-trail/context/memories/<taskId>.md", async () => {
    const dep = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Design the schema",
        description: "Draft the initial notes table.",
        tddEnabled: false, tddPhase: "implement_only",
      }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${dep.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === dep.id);
      return t?.status === "in_review" ? t : null;
    });

    const memPath = join(tmp, ".agent-trail", "context", "memories", `${dep.id}.md`);
    expect(existsSync(memPath)).toBe(true);
  }, 20000);

  test("a downstream task sees the dependency's summary in its own system prompt", async () => {
    // Create A (parent) and B (child depending on A).
    const parent = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Alpha groundwork",
        description: "Ground-work that Beta will build on.",
        tddEnabled: false, tddPhase: "implement_only",
      }),
    })).json() as TaskResp;

    // Run A to completion so its memory is written.
    await fetch(`http://localhost:${port}/api/tasks/${parent.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === parent.id);
      return t?.status === "in_review" ? t : null;
    });

    // Now spawn B depending on A.
    const child = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Beta downstream",
        description: "Consumes Alpha groundwork.",
        tddEnabled: false, tddPhase: "implement_only",
        dependsOn: [parent.id],
      }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${child.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === child.id);
      return t?.status === "in_review" ? t : null;
    });

    // Inspect the echoed prompt from telemetry_events.
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query(
      "SELECT text_content FROM telemetry_events WHERE task_id = ? AND text_content LIKE 'SYSTEM_PROMPT_ECHO:%'",
    ).all(child.id) as { text_content: string }[];
    db.close();

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const prompt = rows[0]!.text_content;
    expect(prompt).toContain("## Task pack (L1)");
    expect(prompt).toContain("=== This task ===");
    expect(prompt).toContain("Beta downstream");
    // The dependency memory should appear in the pack.
    expect(prompt).toContain("=== Dependency: Alpha groundwork ===");
  }, 30000);
});
