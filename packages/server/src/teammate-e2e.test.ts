import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §3.5 — teammate flow.
// A collaborator clones a repo that contains `.agent-trail/state.json` (and
// optionally `.agent-trail/context/*.md`). Running the server should hydrate
// the DB from the state file with no additional setup — same board, same
// tasks, same context.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const SEEDED_STATE = {
  version: 1,
  exported_at: "2026-07-25T00:00:00Z",
  boards: [
    {
      id: "b-teammate",
      name: "Cloned Board",
      prd_source: null,
      webhook_url: null,
      default_model: null,
      default_assignee: "claude-code",
      default_review_kind: "none",
      permission_mode: "acceptEdits",
      implementation_dir: null,
      dev_command: null,
      dev_port: null,
      execution_timeout_ms: 1_200_000,
      execution_cost_cap_usd: 0,
      execution_token_cap: 0,
      auto_commit: 0,
      auto_pr: 0,
      commit_style: "conventional",
      approved_at: "2026-07-25T00:00:00Z",
      created_at: "2026-07-25T00:00:00Z",
      updated_at: "2026-07-25T00:00:00Z",
    },
  ],
  tasks: [
    {
      id: "t-clone-1",
      board_id: "b-teammate",
      title: "Hello from the repo",
      description: "This task was in .agent-trail/state.json when the repo was cloned.",
      status: "backlog",
      priority: "medium",
      assignee: "claude-code",
      tdd_enabled: 0,
      tdd_phase: "implement_only",
      mcps: "[]",
      skills: "[]",
      subagents: "[]",
      depends_on: "[]",
      parallel_group: null,
      active_form: null,
      worktree_path: null,
      last_error: null,
      success_criteria: "[]",
      guardrails: "[]",
      epic: null,
      sprint: null,
      review_kind: "none",
      reviewer: null,
      additional_prompt: null,
      model: null,
      model_tier: null,
      component: null,
      external_dependencies: "[]",
      test_cases: "[]",
      failed_verify_count: 0,
      likely_paths: "[]",
      created_at: "2026-07-25T00:00:00Z",
      updated_at: "2026-07-25T00:00:00Z",
    },
    {
      id: "t-clone-2",
      board_id: "b-teammate",
      title: "Second task",
      description: "",
      status: "backlog",
      priority: "high",
      assignee: "claude-code",
      tdd_enabled: 1,
      tdd_phase: "write_tests",
      mcps: "[]",
      skills: "[]",
      subagents: "[]",
      depends_on: '["t-clone-1"]',
      parallel_group: null,
      active_form: null,
      worktree_path: null,
      last_error: null,
      success_criteria: "[]",
      guardrails: "[]",
      epic: null,
      sprint: null,
      review_kind: "none",
      reviewer: null,
      additional_prompt: null,
      model: null,
      model_tier: null,
      component: null,
      external_dependencies: "[]",
      test_cases: "[]",
      failed_verify_count: 0,
      likely_paths: "[]",
      created_at: "2026-07-25T00:00:00Z",
      updated_at: "2026-07-25T00:00:00Z",
    },
  ],
};

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

interface BoardResp { id: string; name: string }
interface TaskResp { id: string; title: string; boardId: string; status: string; dependsOn: string[]; tddEnabled: boolean; tddPhase: string; priority: string }

describe("teammate flow E2E — PRD 3.5", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";

  beforeAll(async () => {
    // Simulate: a teammate just cloned a repo that contains .agent-trail/state.json.
    tmp = mkdtempSync(join(tmpdir(), "at-teammate-e2e-"));
    mkdirSync(join(tmp, ".agent-trail", "context"), { recursive: true });
    writeFileSync(
      join(tmp, ".agent-trail", "state.json"),
      JSON.stringify(SEEDED_STATE, null, 2),
      "utf8",
    );
    // Also drop a context file so hydration + constitution both fire on first boot.
    writeFileSync(
      join(tmp, ".agent-trail", "context", "conventions.md"),
      "TEAM RULE: reviewer must be tagged.",
      "utf8",
    );

    port = await findFreePort();
    const { AGENT_TRAIL_DB_PATH: _a, VIBE_BOARD_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        AGENT_TRAIL_PORT: String(port),
        AGENT_TRAIL_ROOT: tmp,
        AGENT_TRAIL_SKIP_RUNNER: "1",
        // Keep autosync off — this test only cares about hydration on boot.
        AGENT_TRAIL_SKIP_AUTOSYNC: "1",
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("boards and tasks hydrate from state.json on first boot", async () => {
    const boards = await (await fetch(`http://localhost:${port}/api/boards`)).json() as BoardResp[];
    expect(boards.length).toBe(1);
    expect(boards[0]!.id).toBe("b-teammate");
    expect(boards[0]!.name).toBe("Cloned Board");

    const tasks = await (await fetch(`http://localhost:${port}/api/boards/b-teammate/tasks`)).json() as TaskResp[];
    expect(tasks.length).toBe(2);

    const first  = tasks.find((t) => t.id === "t-clone-1")!;
    const second = tasks.find((t) => t.id === "t-clone-2")!;
    expect(first.title).toBe("Hello from the repo");
    expect(second.dependsOn).toEqual(["t-clone-1"]);
    expect(second.tddEnabled).toBe(true);
    expect(second.tddPhase).toBe("write_tests");
    expect(second.priority).toBe("high");
  });

  test("mutations against a hydrated board persist normally (no state confusion)", async () => {
    const patch = await fetch(`http://localhost:${port}/api/tasks/t-clone-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "edited by teammate" }),
    });
    expect(patch.ok).toBe(true);
    const tasks = await (await fetch(`http://localhost:${port}/api/boards/b-teammate/tasks`)).json() as (TaskResp & { description: string })[];
    const edited = tasks.find((t) => t.id === "t-clone-1")!;
    expect(edited.description).toBe("edited by teammate");
  });
});
