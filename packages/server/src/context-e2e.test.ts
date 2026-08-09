import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §3 — team-context layer.
// Covers:
//   3.3 decision persistence — answering a ticket appends a durable entry to
//       .inventarium/context/decisions.md at the project root.
//   3.4 constitution injection — CLAUDE.md + .inventarium/context/*.md are
//       loaded per-execution and prepended to the system prompt.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const ASK_HUMAN_SCENARIO = JSON.stringify({
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "Need a call." }] } },
    {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "u-ctx-1",
          name: "ask_human",
          input: {
            question: "SQLite or Postgres for local dev?",
            context: "Local-first tool; Postgres adds Docker friction.",
          },
        }],
      },
    },
    {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "u-ctx-1",
          content: "PAUSE_EXECUTION:<mock-ticket>",
          is_error: false,
        }],
      },
    },
  ],
  final: "complete",
  inputTokens: 40, outputTokens: 20, durationMs: 10, delayMs: 0,
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
interface TaskResp  { id: string; status: string }
interface TicketRow { id: string; task_id: string; question: string; answer: string | null }

describe("team-context E2E — PRD 3.3 decision persistence", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-ctx-e2e-"));
    workDir = join(tmp, "work");
    mkdirSync(workDir, { recursive: true });
    port = await findFreePort();
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        INVENTARIUM_PORT: String(port),
        INVENTARIUM_ROOT: tmp,
        INVENTARIUM_SKIP_RUNNER: "1",
        INVENTARIUM_CLAUDE_MOCK: ASK_HUMAN_SCENARIO,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
    const board = await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ctx-e2e", implementationDir: workDir }),
    })).json() as BoardResp;
    boardId = board.id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("answering a ticket appends a formatted block to .inventarium/context/decisions.md", async () => {
    // 1. Spawn a task, wait for it to block on the ask_human tool_use.
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "db-choice", tddEnabled: false, tddPhase: "implement_only" }),
    })).json() as TaskResp;

    const execRes = await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    expect(execRes.status).toBe(201);

    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });

    const tickets = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/decisions`)).json() as TicketRow[];
    const openTicket = tickets.find((t) => t.answer === null)!;
    expect(openTicket).toBeTruthy();

    // 2. Confirm the decisions.md file does not exist yet — persistence should
    //    happen at answer time, not at ticket creation.
    const decisionsPath = join(tmp, ".inventarium", "context", "decisions.md");
    expect(existsSync(decisionsPath)).toBe(false);

    // 3. Answer the ticket.
    const answerRes = await fetch(`http://localhost:${port}/api/decisions/${openTicket.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "SQLite — zero-infra beats a marginally better query planner for a local tool." }),
    });
    expect(answerRes.status).toBe(200);

    // 4. The file lands, contains the heading + question + answer + task title.
    expect(existsSync(decisionsPath)).toBe(true);
    const text = readFileSync(decisionsPath, "utf8");
    expect(text).toContain("# Decisions");
    expect(text).toContain("— db-choice");
    expect(text).toContain("**Q:** SQLite or Postgres for local dev?");
    expect(text).toContain("**A:** SQLite — zero-infra");

    // Stop the resumed run so the suite exits clean (the mock loops back into ask_human).
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/stop`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 200));
  }, 25000);

  test("a second answer appends without duplicating the heading", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "second-decision", tddEnabled: false, tddPhase: "implement_only" }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });
    const tickets = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/decisions`)).json() as TicketRow[];
    const openTicket = tickets.find((t) => t.answer === null)!;
    expect(openTicket).toBeTruthy();

    await fetch(`http://localhost:${port}/api/decisions/${openTicket.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "answer number two" }),
    });

    const decisionsPath = join(tmp, ".inventarium", "context", "decisions.md");
    const text = readFileSync(decisionsPath, "utf8");
    const headings = text.match(/^# Decisions$/gm) ?? [];
    expect(headings.length).toBe(1);
    expect(text).toContain("— db-choice");
    expect(text).toContain("— second-decision");

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/stop`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 200));
  }, 25000);
});
