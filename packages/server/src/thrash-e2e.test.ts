import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §5.3 — thrash detection.
// Two verify_tests failures with the SAME error should short-circuit the
// §4.5 auto-escalation and raise a decision ticket instead. This test uses
// a single unchanging failing suite so both runs produce identical output.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const PASS_MOCK = JSON.stringify({
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
interface TaskResp  { id: string; status: string; modelTier: string | null }
interface DecisionTicket { id: string; question: string; context: string | null; answer: string | null }

describe("thrash detection — PRD §5.3", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let boardId = "";
  let failDir = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-thrash-e2e-"));
    failDir = join(tmp, "thrash-work");
    mkdirSync(failDir, { recursive: true });
    writeFileSync(join(failDir, "package.json"), JSON.stringify({
      name: "thrash", type: "module", scripts: { test: "bun test" },
    }), "utf-8");
    writeFileSync(join(failDir, "boom.test.ts"), `
      import { describe, test, expect } from "bun:test";
      describe("thrash-suite", () => {
        test("intentionally red", () => { expect(1).toBe(2); });
      });
    `, "utf-8");
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
        AGENT_TRAIL_CLAUDE_MOCK: PASS_MOCK,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
    boardId = (await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "thrash-board", implementationDir: failDir }),
    })).json() as BoardResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("2 identical verify_tests failures → decision ticket raised, tier NOT escalated", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "thrash-me",
        tddEnabled: true,
        tddPhase: "verify_tests",
        modelTier: "sonnet",
      }),
    })).json() as TaskResp;

    // Belt-and-braces — even if a heavily-loaded test run causes the thrash
    // normalize to miss (real bun-test output can occasionally include a
    // byte that survives normalization), the §4.5 escalation threshold is
    // so high it can't fire either. Isolates §5.3.
    await fetch(`http://localhost:${port}/api/tasks/${task.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loopPolicy: { escalation: { escalateAfterFailures: 99, thrashDetection: true } },
      }),
    });

    // First run — no ticket yet, no escalation.
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });

    // Second identical failure — thrash fires.
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const tickets = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/decisions`)).json() as DecisionTicket[];
      return tickets.length > 0 ? tickets : null;
    });

    const tickets = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/decisions`)).json() as DecisionTicket[];
    expect(tickets.length).toBe(1);
    expect(tickets[0]!.question).toContain("thrashing");
    expect(tickets[0]!.context).toContain("repeated_failure");
    expect(tickets[0]!.answer).toBeNull();

    // Because thrash short-circuits §4.5, the tier stays on sonnet (no
    // auto-escalation, no auto-restart).
    const latest = (await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[])
      .find((t) => t.id === task.id)!;
    expect(latest.modelTier).toBe("sonnet");
    expect(latest.status).toBe("blocked");
  }, 40000);
});
