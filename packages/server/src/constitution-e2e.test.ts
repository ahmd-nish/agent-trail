import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE 3.4 — the L0 constitution (CLAUDE.md + .agent-trail/context/*.md)
// is loaded per-execution and prepended to the system prompt.
//
// The mock adapter's `echoSystemPrompt` flag prepends an assistant text event
// containing the exact prompt the adapter received. That event flows through
// the executionManager into `telemetry_events.text_content`, so we can inspect
// the row after the run and confirm the constitution files landed in the prompt.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const ECHO_SCENARIO = JSON.stringify({
  echoSystemPrompt: true,
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
  ],
  final: "complete",
  inputTokens: 10, outputTokens: 5, durationMs: 10, delayMs: 0,
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

async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollFor timeout");
}

interface BoardResp { id: string; name: string }
interface TaskResp { id: string; status: string }
interface ExecutionRow { id: string; status: string }

describe("constitution injection E2E — PRD 3.4", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let dbPath = "";
  let boardId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-constitution-e2e-"));
    workDir = join(tmp, "work");
    mkdirSync(workDir, { recursive: true });

    // Seed a CLAUDE.md at the project root + a context file.
    writeFileSync(join(tmp, "CLAUDE.md"), "PROJECT LAW: bun-only, TypeScript strict.", "utf8");
    mkdirSync(join(tmp, ".agent-trail", "context"), { recursive: true });
    writeFileSync(
      join(tmp, ".agent-trail", "context", "conventions.md"),
      "TEAM CONVENTION: reviewer must be tagged before merge.",
      "utf8",
    );

    port = await findFreePort();
    dbPath = join(tmp, "agent-trail.db");
    const { AGENT_TRAIL_DB_PATH: _a, VIBE_BOARD_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        AGENT_TRAIL_PORT: String(port),
        AGENT_TRAIL_ROOT: tmp,
        AGENT_TRAIL_SKIP_RUNNER: "1",
        AGENT_TRAIL_CLAUDE_MOCK: ECHO_SCENARIO,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
    const board = await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "constitution-e2e", implementationDir: workDir }),
    })).json() as BoardResp;
    boardId = board.id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("CLAUDE.md + context files appear in the system prompt sent to the adapter", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "run-me", tddEnabled: false, tddPhase: "implement_only" }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });

    // Wait for the execution to reach a terminal state.
    await pollFor(async () => {
      const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
      const done = execs.find((e) => e.status === "completed" || e.status === "failed" || e.status === "awaiting_human");
      return done ?? null;
    });

    // Query telemetry_events directly for the echoed prompt.
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query(
      "SELECT text_content FROM telemetry_events WHERE task_id = ? AND text_content LIKE 'SYSTEM_PROMPT_ECHO:%'",
    ).all(task.id) as { text_content: string }[];
    db.close();

    expect(rows.length).toBe(1);
    const prompt = rows[0]!.text_content;
    expect(prompt).toContain("## Team constitution");
    expect(prompt).toContain("=== CLAUDE.md ===");
    expect(prompt).toContain("PROJECT LAW: bun-only");
    expect(prompt).toContain("=== .agent-trail/context/conventions.md ===");
    expect(prompt).toContain("TEAM CONVENTION: reviewer");
  }, 20000);
});
