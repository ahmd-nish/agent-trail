import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD 1.6 — ask_human decision tickets.
// Acceptance:
//   • Agent pauses on ask_human           → task lands `blocked` (execution status `awaiting_human`)
//   • Card shows question                 → GET /api/tasks/:id/decisions returns the open ticket
//   • Answer resumes execution            → POST /api/decisions/:id/answer flips ticket + kicks off a new execution
//
// The mock adapter mirrors what the real MCP `ask_human` tool does: it inserts
// a decision_tickets row when it fires a tool_use with name `ask_human`. The
// execution manager's onEvent tracker + post-run DB cross-check then treats
// the completion as `awaiting_human`.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

// Scenario: assistant fires an ask_human tool_use, user block returns a
// successful tool_result. No completion after that — the executionManager
// sees the ask_human success + a persisted ticket and finalizes as
// awaiting_human.
const ASK_HUMAN_SCENARIO = JSON.stringify({
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "I need a decision before continuing." }] } },
    {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "u-ah-1",
          name: "ask_human",
          input: {
            question: "Should the code return 404 JSON or an HTML page?",
            context: "The API otherwise returns JSON, but this endpoint is user-facing.",
          },
        }],
      },
    },
    {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "u-ah-1",
          content: "PAUSE_EXECUTION:<mock-ticket>",
          is_error: false,
        }],
      },
    },
  ],
  final: "complete",
  inputTokens: 80, outputTokens: 40, durationMs: 10, delayMs: 0,
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
interface TaskResp  { id: string; status: string; activeForm: string | null }
interface TicketRow { id: string; task_id: string; question: string; context: string | null; answer: string | null; answered_at: string | null }
interface ExecutionRow { id: string; status: string; error_message: string | null }

describe("ask_human decision tickets E2E — PRD 1.6", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-askhuman-e2e-"));
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
      body: JSON.stringify({ name: "ask-human-e2e", implementationDir: workDir }),
    })).json() as BoardResp;
    boardId = board.id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("ask_human tool_use → task lands `blocked`, execution `awaiting_human`, ticket written", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "wait-for-me", tddEnabled: false, tddPhase: "implement_only" }),
    })).json() as TaskResp;

    const execRes = await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    expect(execRes.status).toBe(201);

    // 1. Task lands in `blocked` (inventarium's "waiting on human" state).
    const finalTask = await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });
    expect(finalTask.status).toBe("blocked");

    // 2. Execution row is marked `awaiting_human` (not `failed` — the run was
    //    intentionally paused, not aborted).
    const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
    expect(execs.length).toBe(1);
    expect(execs[0]!.status).toBe("awaiting_human");
    expect(execs[0]!.error_message).toBeNull();

    // 3. Decision ticket exists — the "card shows question" acceptance is
    //    proven by the ticket being fetchable + unanswered + carrying the
    //    exact question + context claude asked.
    const tickets = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/decisions`)).json() as TicketRow[];
    expect(tickets.length).toBe(1);
    const ticket = tickets[0]!;
    expect(ticket.answer).toBeNull();
    expect(ticket.answered_at).toBeNull();
    expect(ticket.question).toBe("Should the code return 404 JSON or an HTML page?");
    expect(ticket.context).toContain("API otherwise returns JSON");
  }, 20000);

  test("POST /api/decisions/:id/answer records answer + resumes execution", async () => {
    // Fresh task so we're not tangled with the previous test's state.
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "answer-me", tddEnabled: false, tddPhase: "implement_only" }),
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

    // Answer the ticket. The server records it, then calls executionManager.resume.
    const answerRes = await fetch(`http://localhost:${port}/api/decisions/${openTicket.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "Go with the HTML error page — better UX for browser paste-ins." }),
    });
    expect(answerRes.status).toBe(200);
    const answerBody = await answerRes.json() as { ok: boolean; executionId: string };
    expect(answerBody.ok).toBe(true);
    expect(answerBody.executionId).toBeString();

    // 1. Ticket now shows the answer + answered_at.
    const after = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/decisions`)).json() as TicketRow[];
    const answered = after.find((t) => t.id === openTicket.id)!;
    expect(answered.answer).toContain("HTML error page");
    expect(answered.answered_at).toBeTruthy();

    // 2. A second execution row now exists — the resume kicked off a new run.
    //    (The mock will loop back into ask_human again — that's fine, we're
    //    just proving the resume was triggered. Stop it to keep the test
    //    graph clean.)
    await pollFor(async () => {
      const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
      return execs.length >= 2 ? execs : null;
    });
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/stop`, { method: "POST" });
    // Let the SIGTERM path settle so the task row isn't mid-write when the suite ends.
    await new Promise((r) => setTimeout(r, 200));
  }, 25000);

  test("answering an unknown ticket → 404", async () => {
    const res = await fetch(`http://localhost:${port}/api/decisions/00000000-nope/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "hi" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("ticket not found");
  });

  test("answering the same ticket twice → 409", async () => {
    // Reuse an already-answered ticket if we still have one, else create a new
    // task-and-ticket chain.
    let ticket: TicketRow | undefined;
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "answer-twice", tddEnabled: false, tddPhase: "implement_only" }),
    })).json() as TaskResp;
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });
    const tickets = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/decisions`)).json() as TicketRow[];
    ticket = tickets.find((t) => t.answer === null);
    expect(ticket).toBeTruthy();
    if (!ticket) return;

    const first = await fetch(`http://localhost:${port}/api/decisions/${ticket.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "first answer" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`http://localhost:${port}/api/decisions/${ticket.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "second answer" }),
    });
    expect(second.status).toBe(409);
    expect((await second.json() as { error: string }).error).toBe("already answered");

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/stop`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 200));
  }, 25000);

  test("empty answer → 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/decisions/anything/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "   " }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("answer is required");
  });
});
