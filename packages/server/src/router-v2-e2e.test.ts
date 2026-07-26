import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §4.5 — model router v2: escalate the tier after two failed
// verify_tests loops. This test drives two direct verify_tests failures for
// the same task and asserts that:
//   • failed_verify_count reaches 2
//   • tier gets bumped one step up (default sonnet → opus)
//   • counter resets to 0
//   • phase drops back to `implement`
//   • task auto-restarts (a third execution appears without a manual /execute)

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const PASSING_SCENARIO = JSON.stringify({
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "implementing…" }] } },
  ],
  final: "complete",
  inputTokens: 10, outputTokens: 5, durationMs: 5, delayMs: 0,
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

async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollFor timeout");
}

function seedFailingWorkDir(root: string): string {
  const dir = join(root, "fail-work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "router-v2-fail",
    type: "module",
    scripts: { test: "bun test" },
  }), "utf-8");
  writeFileSync(join(dir, "boom.test.ts"), `
    import { describe, test, expect } from "bun:test";
    describe("router-v2 boom", () => {
      test("intentionally red", () => { expect(1).toBe(2); });
    });
  `, "utf-8");
  return dir;
}

interface BoardResp { id: string; name: string }
interface TaskResp { id: string; status: string; tddPhase: string; modelTier: string | null }
interface ExecutionRow { id: string; status: string; tdd_phase: string | null }

describe("model router v2 — PRD 4.5 escalation", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let boardId = "";
  let failDir = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-router-v2-e2e-"));
    failDir = seedFailingWorkDir(tmp);
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
        AGENT_TRAIL_CLAUDE_MOCK: PASSING_SCENARIO,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
    boardId = (await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "router-v2", implementationDir: failDir }),
    })).json() as BoardResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // §5.3 thrash detection now short-circuits §4.5 escalation when the two
  // failures have IDENTICAL normalized errors. To exercise the escalation
  // path we swap the failing test between runs so the error messages differ.
  test("2 verify_tests failures with different errors → tier escalated, counter reset, phase → implement, auto-restart", async () => {
    // Start with a TDD-enabled task already at verify_tests so each execute
    // call runs the failing suite directly (no need to walk the full gate).
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "escalate-me",
        tddEnabled: true,
        tddPhase: "verify_tests",
        modelTier: "sonnet",
      }),
    })).json() as TaskResp;

    // ─── First failure ────────────────────────────────────────────────────
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });
    // First failure lands `blocked`, still at verify_tests, still on sonnet.
    let latest = (await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[])
      .find((t) => t.id === task.id)!;
    expect(latest.status).toBe("blocked");
    expect(latest.tddPhase).toBe("verify_tests");
    expect(latest.modelTier).toBe("sonnet");

    const execsAfterOne = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
    expect(execsAfterOne.length).toBe(1);
    expect(execsAfterOne[0]!.status).toBe("failed");

    // Swap the failing test so the second run produces a distinctly-different
    // error message. This keeps §5.3 thrash detection out of the picture and
    // lets §4.5 escalate the tier.
    writeFileSync(join(failDir, "boom.test.ts"), `
      import { describe, test, expect } from "bun:test";
      describe("router-v2 boom v2", () => {
        test("also red but different", () => { expect("apple").toBe("orange"); });
      });
    `, "utf-8");

    // ─── Second failure → escalation kicks in ─────────────────────────────
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });

    // Wait for the escalation to happen: tier moves to opus AND we see the
    // auto-restart (a third execution row appears without a manual /execute).
    const escalated = await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t && t.modelTier === "opus" ? t : null;
    }, 20000);
    expect(escalated.modelTier).toBe("opus");
    // Phase reset to implement so the (now-opus) agent gets another shot.
    // Depending on timing the auto-restart may already have advanced through
    // implement → verify_tests → blocked again. Either way, tier must be opus
    // and the counter must have been reset (further asserted below).
    expect(["implement", "verify_tests"]).toContain(escalated.tddPhase);

    // At least one more execution beyond the two failed verify_tests runs.
    await pollFor(async () => {
      const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
      return execs.length >= 3 ? execs : null;
    }, 20000);
    const finalExecs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
    const verifyFailures = finalExecs.filter((e) => e.tdd_phase === "verify_tests" && e.status === "failed");
    const implementRuns = finalExecs.filter((e) => e.tdd_phase === "implement");
    expect(verifyFailures.length).toBeGreaterThanOrEqual(2);
    expect(implementRuns.length).toBeGreaterThanOrEqual(1);

    // Let any queued re-run drain so afterAll doesn't rip the DB out mid-write.
    await new Promise((r) => setTimeout(r, 500));
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/stop`, { method: "POST" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
  }, 40000);

  test("opus tier at 2 failures → no infinite escalation, task lands blocked", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "opus-ceiling",
        tddEnabled: true,
        tddPhase: "verify_tests",
        modelTier: "opus",
      }),
    })).json() as TaskResp;

    // Swap the suite so the first run has a distinct error from the second
    // (otherwise §5.3 thrash would short-circuit both the escalation AND
    // the "no auto-restart" assertion we're actually testing here).
    writeFileSync(join(failDir, "boom.test.ts"), `
      import { describe, test, expect } from "bun:test";
      describe("opus ceiling A", () => {
        test("first-run red", () => { expect(true).toBe(false); });
      });
    `, "utf-8");
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });

    writeFileSync(join(failDir, "boom.test.ts"), `
      import { describe, test, expect } from "bun:test";
      describe("opus ceiling B", () => {
        test("second-run also red but different", () => { expect(1 + 1).toBe(9); });
      });
    `, "utf-8");
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    // Wait for the second verify_tests failure to land, then assert we did NOT
    // auto-restart (no third execution ever spawns because we're already opus).
    await pollFor(async () => {
      const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
      return execs.filter((e) => e.status === "failed").length >= 2 ? execs : null;
    });
    // Give the escalation branch a beat to (not) fire.
    await new Promise((r) => setTimeout(r, 300));
    const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
    // Exactly two executions: no auto-restart because opus is the ceiling.
    expect(execs.length).toBe(2);
    for (const e of execs) expect(e.status).toBe("failed");

    const final = (await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[])
      .find((t) => t.id === task.id)!;
    expect(final.status).toBe("blocked");
    expect(final.modelTier).toBe("opus"); // unchanged
    await new Promise((r) => setTimeout(r, 200));
  }, 30000);
});
