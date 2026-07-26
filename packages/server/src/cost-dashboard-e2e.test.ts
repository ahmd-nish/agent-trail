import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §4.6 — token/cost dashboard E2E.
// Two tasks on different tiers, run them via mock adapter (which stamps
// input/output tokens on each execution row), then hit /api/boards/:id/cost.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const MOCK = JSON.stringify({
  events: [{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }],
  final: "complete",
  inputTokens: 100_000, outputTokens: 40_000, durationMs: 5,
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
interface CostResp  {
  boardId: string;
  byTier: Array<{ tier: string; inputTokens: number; outputTokens: number; usd: number; executions: number }>;
  totals: { inputTokens: number; outputTokens: number; usd: number; executions: number };
  baseline: { usd: number; savingsUsd: number; savingsPct: number };
}

describe("cost dashboard — PRD §4.6", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-cost-e2e-"));
    workDir = join(tmp, "work");
    mkdirSync(workDir, { recursive: true });
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
        AGENT_TRAIL_CLAUDE_MOCK: MOCK,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
    boardId = (await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cost", implementationDir: workDir }),
    })).json() as BoardResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("empty board — cost endpoint returns zeros and 0% savings", async () => {
    const res = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/cost`)).json() as CostResp;
    expect(res.totals.usd).toBe(0);
    expect(res.totals.executions).toBe(0);
    expect(res.baseline.savingsPct).toBe(0);
  });

  test("mixed haiku + opus workload — per-tier breakdown + non-zero savings vs baseline", async () => {
    // Run a haiku task and an opus task. Each mock run stamps 100K/40K tokens
    // onto the execution row. We compare the actual billed cost to the
    // "everything on sonnet" baseline.
    for (const tier of ["haiku", "opus"] as const) {
      const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${tier}-task`, tddEnabled: false, tddPhase: "implement_only",
          modelTier: tier,
        }),
      })).json() as TaskResp;
      await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
      await pollFor(async () => {
        const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
        const t = list.find((r) => r.id === task.id);
        return t?.status === "in_review" ? t : null;
      });
    }

    const res = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/cost`)).json() as CostResp;
    expect(res.totals.executions).toBeGreaterThanOrEqual(2);
    expect(res.totals.inputTokens).toBeGreaterThanOrEqual(200_000);
    expect(res.totals.usd).toBeGreaterThan(0);

    const tiers = res.byTier.map((r) => r.tier);
    expect(tiers).toContain("haiku");
    expect(tiers).toContain("opus");

    // Real cost includes the opus premium — should EXCEED the sonnet-only
    // baseline (savings negative). Proves the baseline math is meaningful.
    expect(res.baseline.savingsUsd).toBeLessThan(0);
    expect(res.baseline.savingsPct).toBeLessThan(0);
  }, 30000);
});
