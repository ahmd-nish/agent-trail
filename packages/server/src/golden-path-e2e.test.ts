import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// ─── Golden-path E2E — Phase 1 → 4.5 in one flow ─────────────────────────────
//
// Boots ONE server backed by a fresh workdir that carries:
//   • CLAUDE.md and .inventarium/context/conventions.md   (§3.4 constitution)
//   • .inventarium/state.json                              (§3.1 hydration)
//   • two bun-testable subdirs — one passing, one failing  (§1.5 TDD gate)
//
// Then it exercises, in order:
//   1. Hydration on boot — the pre-seeded state.json becomes the DB
//   2. Constitution injection — the mock echoes the system prompt, which we
//      then inspect from telemetry_events (§3.4)
//   3. TDD gate walk on the passing suite — task lands `in_review` after
//      write_tests → implement → verify_tests (§1.5)
//   4. Auto-sync — mutations picked up by startAutoSync and written back to
//      state.json (§3.1)
//   5. Router-v2 escalation — TDD task pointed at the failing suite fails
//      verify_tests twice → tier escalates sonnet → opus, phase resets to
//      `implement`, auto-restart fires (§4.5)
//
// Every assertion is real: the mock adapter drives Claude callbacks, but
// runTests spawns bun for real against the fixture suites and state.json
// lands on disk via the same code path production takes.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const MAX_ITERS_PER_POLL = 20_000;

const MOCK_SCENARIO = JSON.stringify({
  echoSystemPrompt: true,
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "phase work…" }] } },
  ],
  final: "complete",
  inputTokens: 20, outputTokens: 10, durationMs: 5, delayMs: 0,
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

async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = MAX_ITERS_PER_POLL): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollFor timeout");
}

function seedPassingSuite(root: string): string {
  const dir = join(root, "pass-work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "gp-pass", type: "module", scripts: { test: "bun test" },
  }), "utf-8");
  writeFileSync(join(dir, "sanity.test.ts"),
    `import { test, expect } from "bun:test";\ntest("green", () => { expect(1 + 1).toBe(2); });\n`,
    "utf-8",
  );
  return dir;
}

function seedFailingSuite(root: string): string {
  const dir = join(root, "fail-work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "gp-fail", type: "module", scripts: { test: "bun test" },
  }), "utf-8");
  writeFileSync(join(dir, "boom.test.ts"),
    `import { test, expect } from "bun:test";\ntest("red", () => { expect(1).toBe(2); });\n`,
    "utf-8",
  );
  return dir;
}

interface BoardResp { id: string; name: string }
interface TaskResp { id: string; status: string; tddPhase: string; modelTier: string | null; tddEnabled: boolean }
interface ExecutionRow { id: string; status: string; tdd_phase: string | null }

const PRESEEDED_BOARD_ID = "gp-preseeded-board";
const PRESEEDED_TASK_ID  = "gp-preseeded-task";

describe("golden-path E2E — Phase 1 → 4.5 in one flow", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let passDir = "";
  let failDir = "";
  let dbPath = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-golden-path-"));
    dbPath = join(tmp, "inventarium.db");

    // ─── §3.4 constitution files ────────────────────────────────────────────
    writeFileSync(join(tmp, "CLAUDE.md"), "GOLDEN LAW: bun-only, TS strict.", "utf-8");
    mkdirSync(join(tmp, ".inventarium", "context"), { recursive: true });
    writeFileSync(join(tmp, ".inventarium", "context", "conventions.md"),
      "TEAM CONVENTION: reviewer must be tagged before merge.", "utf-8");

    // ─── §3.1 state.json to hydrate on boot ─────────────────────────────────
    // A pre-seeded (implement_only) task so we can prove the DB was hydrated
    // straight from disk before the server touched any HTTP endpoint.
    const state = {
      version: 1,
      exported_at: "2026-07-25T00:00:00Z",
      boards: [{
        id: PRESEEDED_BOARD_ID, name: "Pre-seeded", prd_source: null, webhook_url: null,
        default_model: null, default_assignee: "claude-code", default_review_kind: "none",
        permission_mode: "acceptEdits", implementation_dir: null, dev_command: null, dev_port: null,
        execution_timeout_ms: 1_200_000, execution_cost_cap_usd: 0, execution_token_cap: 0,
        auto_commit: 0, auto_pr: 0, commit_style: "conventional",
        approved_at: "2026-07-25T00:00:00Z",
        created_at: "2026-07-25T00:00:00Z", updated_at: "2026-07-25T00:00:00Z",
      }],
      tasks: [{
        id: PRESEEDED_TASK_ID, board_id: PRESEEDED_BOARD_ID, title: "Pre-seeded task",
        description: "This task was in state.json before the server started.",
        status: "backlog", priority: "medium", assignee: "claude-code",
        tdd_enabled: 0, tdd_phase: "implement_only",
        mcps: "[]", skills: "[]", subagents: "[]", depends_on: "[]",
        parallel_group: null, active_form: null, worktree_path: null, last_error: null,
        success_criteria: "[]", guardrails: "[]", epic: null, sprint: null,
        review_kind: "none", reviewer: null, additional_prompt: null,
        model: null, model_tier: null, component: null,
        external_dependencies: "[]", test_cases: "[]", failed_verify_count: 0,
        likely_paths: "[]",
        created_at: "2026-07-25T00:00:00Z", updated_at: "2026-07-25T00:00:00Z",
      }],
    };
    writeFileSync(join(tmp, ".inventarium", "state.json"), JSON.stringify(state, null, 2), "utf-8");

    // Two real bun suites — one passes, one fails.
    passDir = seedPassingSuite(tmp);
    failDir = seedFailingSuite(tmp);

    port = await findFreePort();
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        INVENTARIUM_PORT: String(port),
        INVENTARIUM_ROOT: tmp,
        INVENTARIUM_SKIP_RUNNER: "1",
        INVENTARIUM_AUTOSYNC_MS: "150",           // fast autosync for the test
        INVENTARIUM_CLAUDE_MOCK: MOCK_SCENARIO,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("§3.1 hydration — pre-seeded state.json becomes the DB before any HTTP write", async () => {
    const boards = await (await fetch(`http://localhost:${port}/api/boards`)).json() as BoardResp[];
    const preseeded = boards.find((b) => b.id === PRESEEDED_BOARD_ID);
    expect(preseeded).toBeDefined();
    expect(preseeded!.name).toBe("Pre-seeded");

    const tasks = await (await fetch(`http://localhost:${port}/api/boards/${PRESEEDED_BOARD_ID}/tasks`)).json() as TaskResp[];
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.id).toBe(PRESEEDED_TASK_ID);
  });

  test("§1.5 + §3.4 — TDD gate walks a passing suite AND the constitution reaches the adapter", async () => {
    // Fresh board pointed at the passing suite.
    const board = await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "golden-tdd", implementationDir: passDir }),
    })).json() as BoardResp;

    const task = await (await fetch(`http://localhost:${port}/api/boards/${board.id}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "walk-the-gate", tddEnabled: true, tddPhase: "write_tests" }),
    })).json() as TaskResp;

    const execRes = await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    expect(execRes.status).toBe(201);

    const final = await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${board.id}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      if (t?.status === "in_review" || t?.status === "blocked") return t;
      return null;
    });
    // §1.5 — TDD gate walked to green.
    expect(final.status).toBe("in_review");
    expect(final.tddPhase).toBe("verify_tests");

    const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
    expect(execs.length).toBe(3);
    const phases = new Set(execs.map((e) => e.tdd_phase));
    expect(phases.has("write_tests")).toBe(true);
    expect(phases.has("implement")).toBe(true);
    expect(phases.has("verify_tests")).toBe(true);

    // §3.4 — constitution rendered into the system prompt.
    const db = new Database(dbPath, { readonly: true });
    const echoes = db.query(
      "SELECT text_content FROM telemetry_events WHERE task_id = ? AND text_content LIKE 'SYSTEM_PROMPT_ECHO:%'",
    ).all(task.id) as { text_content: string }[];
    db.close();
    expect(echoes.length).toBeGreaterThanOrEqual(2); // write_tests + implement each get their own prompt
    const firstPrompt = echoes[0]!.text_content;
    expect(firstPrompt).toContain("## Team constitution");
    expect(firstPrompt).toContain("=== CLAUDE.md ===");
    expect(firstPrompt).toContain("GOLDEN LAW: bun-only");
    expect(firstPrompt).toContain("=== .inventarium/context/conventions.md ===");
    expect(firstPrompt).toContain("TEAM CONVENTION");
  }, 40000);

  test("§3.1 autosync — new boards/tasks flow into state.json without a manual export", async () => {
    // Give autosync (150 ms interval) a couple of ticks to flush all the state
    // that the previous tests already wrote.
    const statePath = join(tmp, ".inventarium", "state.json");
    const state = await pollFor(async () => {
      if (!existsSync(statePath)) return null;
      try {
        const raw = JSON.parse(readFileSync(statePath, "utf-8")) as {
          boards: { id: string }[]; tasks: { id: string; title: string }[];
        };
        // At least the pre-seeded board + the golden-tdd board created above.
        const boardIds = raw.boards.map((b) => b.id);
        const taskTitles = raw.tasks.map((t) => t.title);
        if (boardIds.includes(PRESEEDED_BOARD_ID) && taskTitles.includes("walk-the-gate")) return raw;
        return null;
      } catch { return null; }
    });
    expect(state.boards.length).toBeGreaterThanOrEqual(2);
    expect(state.tasks.some((t) => t.title === "walk-the-gate")).toBe(true);
  }, 15000);

  test("§4.5 — two failed verify_tests loops → tier escalates sonnet → opus + auto-restart", async () => {
    const board = await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "golden-router-v2", implementationDir: failDir }),
    })).json() as BoardResp;

    const task = await (await fetch(`http://localhost:${port}/api/boards/${board.id}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "escalate", tddEnabled: true, tddPhase: "verify_tests", modelTier: "sonnet",
      }),
    })).json() as TaskResp;

    // First failure — blocks, no escalation yet.
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${board.id}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "blocked" ? t : null;
    });
    let latest = (await (await fetch(`http://localhost:${port}/api/boards/${board.id}/tasks`)).json() as TaskResp[])
      .find((t) => t.id === task.id)!;
    expect(latest.modelTier).toBe("sonnet");

    // §5.3 thrash detection would short-circuit escalation if the two
    // failures were byte-identical. Swap the suite so the second run
    // produces a distinctly-different error message.
    writeFileSync(join(failDir, "boom.test.ts"),
      `import { test, expect } from "bun:test";\ntest("red-b", () => { expect("a").toBe("b"); });\n`,
      "utf-8",
    );

    // Second failure — escalation kicks in, tier goes to opus, task auto-restarts.
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    const escalated = await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${board.id}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t && t.modelTier === "opus" ? t : null;
    });
    expect(escalated.modelTier).toBe("opus");

    // At least one implement run appeared after escalation (auto-restart).
    await pollFor(async () => {
      const execs = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/executions`)).json() as ExecutionRow[];
      return execs.some((e) => e.tdd_phase === "implement") ? execs : null;
    });

    // Let the queue drain so afterAll doesn't rip the DB out mid-write.
    await fetch(`http://localhost:${port}/api/tasks/${task.id}/stop`, { method: "POST" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  }, 40000);
});
