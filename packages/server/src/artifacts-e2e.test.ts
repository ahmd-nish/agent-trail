import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD 1.7 — post-execution artifacts on the card.
// Acceptance:
//   • git diff        — captured after any run that lands `in_review`
//   • test output     — captured after a verify_tests run (pass or fail)
//   • modified files  — captured (kind='file_list') from git status --porcelain

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const HAPPY_SCENARIO = JSON.stringify({
  events: [
    { type: "assistant", message: { content: [{ type: "text", text: "modifying files..." }] } },
  ],
  final: "complete",
  inputTokens: 20, outputTokens: 5, durationMs: 5, delayMs: 0,
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

interface BoardResp   { id: string; name: string }
interface TaskResp    { id: string; status: string }
interface ArtifactRow { id: string; kind: string; content: string; execution_id: string }

// Seed a git repo with one committed file, then modify the file so a diff exists.
function seedGitWorktree(root: string): string {
  const dir = join(root, "worktree");
  mkdirSync(dir, { recursive: true });

  // Give the initial commit a working env — some CI containers lack a user.
  const g = (args: string[]) => spawnSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME:  "artifact-test",
      GIT_AUTHOR_EMAIL: "artifact@test.local",
      GIT_COMMITTER_NAME:  "artifact-test",
      GIT_COMMITTER_EMAIL: "artifact@test.local",
    },
  });
  g(["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "# initial\n", "utf-8");
  g(["add", "README.md"]);
  g(["commit", "-q", "-m", "seed"]);

  // Dirty the working tree so `git diff HEAD` produces output.
  writeFileSync(join(dir, "README.md"), "# initial\nline added by mock run\n", "utf-8");
  // Add an untracked file so `git status --porcelain` has a `??` line too.
  writeFileSync(join(dir, "notes.txt"), "hi\n", "utf-8");

  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "artifact-test",
    type: "module",
    scripts: { test: "bun test" },
  }), "utf-8");
  writeFileSync(join(dir, "green.test.ts"), `
    import { test, expect } from "bun:test";
    test("green", () => expect(1).toBe(1));
  `, "utf-8");

  return dir;
}

describe("post-execution artifacts E2E — PRD 1.7", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-artifacts-e2e-"));
    workDir = seedGitWorktree(tmp);
    port = await findFreePort();
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        INVENTARIUM_PORT: String(port),
        INVENTARIUM_ROOT: tmp,
        INVENTARIUM_SKIP_RUNNER: "1",
        INVENTARIUM_CLAUDE_MOCK: HAPPY_SCENARIO,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
    boardId = (await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "artifacts-e2e", implementationDir: workDir }),
    })).json() as BoardResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("claude run: git_diff + file_list artifacts land on the task", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "diff-me", tddEnabled: false, tddPhase: "implement_only" }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "in_review" ? t : null;
    });

    const artifacts = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/artifacts`)).json() as ArtifactRow[];
    const kinds = new Set(artifacts.map((a) => a.kind));
    expect(kinds.has("git_diff")).toBe(true);
    expect(kinds.has("file_list")).toBe(true);

    const diff = artifacts.find((a) => a.kind === "git_diff")!;
    expect(diff.content).toContain("README.md");
    expect(diff.content).toContain("line added by mock run");

    const files = artifacts.find((a) => a.kind === "file_list")!;
    // git status --porcelain marks a tracked-file mod with " M" or "M " and an
    // untracked file with "??". Assert both showed up so the "modified files"
    // list is faithful.
    expect(files.content).toContain("README.md");
    expect(files.content).toContain("notes.txt");
  }, 20000);

  test("verify_tests run: test_output artifact land on the task", async () => {
    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "verify-artifact",
        tddEnabled: true,
        tddPhase: "verify_tests",
      }),
    })).json() as TaskResp;

    await fetch(`http://localhost:${port}/api/tasks/${task.id}/execute`, { method: "POST" });
    await pollFor(async () => {
      const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
      const t = list.find((r) => r.id === task.id);
      return t?.status === "in_review" ? t : null;
    });

    const artifacts = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/artifacts`)).json() as ArtifactRow[];
    const testOutput = artifacts.find((a) => a.kind === "test_output");
    expect(testOutput).toBeTruthy();
    // Sanity: the artifact carries actual runner output (bun's summary line).
    expect(testOutput!.content).toMatch(/pass|test/i);
  }, 20000);

  test("GET /api/artifacts/:id fetches a single artifact by id", async () => {
    // Reuse the first task's artifacts.
    const tasks = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
    const diffTask = tasks.find((t) => t.status === "in_review");
    expect(diffTask).toBeTruthy();
    const artifacts = await (await fetch(`http://localhost:${port}/api/tasks/${diffTask!.id}/artifacts`)).json() as ArtifactRow[];
    const one = artifacts[0]!;
    const single = await (await fetch(`http://localhost:${port}/api/artifacts/${one.id}`)).json() as ArtifactRow;
    expect(single.id).toBe(one.id);
    expect(single.kind).toBe(one.kind);
  });

  test("GET /api/artifacts/:id returns 404 for an unknown id", async () => {
    const res = await fetch(`http://localhost:${port}/api/artifacts/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
