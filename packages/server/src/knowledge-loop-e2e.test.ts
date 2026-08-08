import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { Database } from "bun:sqlite";

// knowledgelayer-v2 §2 — Phase 0 exit criterion, as an assertion.
//
// The whole thesis in one test: a real run produces knowledge events, and a
// LATER task inherits them without anyone writing anything down. Every piece
// of this shipped with unit tests in d4bcbb5 and a6fd8c0, and the loop was
// still broken end-to-end for two weeks — `paths` was read off the wrong
// field name, so every event carried [] and the §4.5 governance gate could
// never match. Unit tests could not see that. This test can.
//
// Task A fails verify_tests on src/auth.ts  -> failed_attempt event.
// Task B declares the same file footprint   -> its pack must carry
//   (a) the event, via §4.3 FTS5 retrieval, and
//   (b) a §4.5 governance warning naming the file.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const MOCK = JSON.stringify({
  events: [{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }],
  final: "complete", inputTokens: 250, outputTokens: 90,
  cacheReadTokens: 800, cacheCreationTokens: 120, durationMs: 42,
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

async function waitForHealth(port: number, ms = 20000): Promise<boolean> {
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

async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 25000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("pollFor timeout");
}

interface Idd { id: string }
interface TaskResp { id: string; status: string }

describe("knowledge loop — knowledgelayer-v2 §2 Phase 0", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let boardId = "";
  let dbPath = "";

  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await res.json() as T;
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-knowledge-loop-"));
    const work = join(tmp, "work");
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "package.json"), JSON.stringify({
      name: "kloop", type: "module", scripts: { test: "bun test" },
    }), "utf-8");
    writeFileSync(join(work, "src", "auth.ts"), "export function login() { return false; }\n", "utf-8");
    // An unchanging red suite — the point is a deterministic failure, not a fix loop.
    writeFileSync(join(work, "auth.test.ts"), `
      import { test, expect } from "bun:test";
      test("login should succeed", () => { expect(1).toBe(2); });
    `, "utf-8");

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
        AGENT_TRAIL_CLAUDE_MOCK: MOCK,
      },
      stdio: "ignore",
    });
    if (!await waitForHealth(port)) throw new Error(`server did not start on ${port}`);

    boardId = (await api<Idd>("POST", "/api/boards", {
      name: "knowledge-loop", implementationDir: work,
    })).id;
  }, 40000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("a failed task emits an event, and the next task on the same files inherits it", async () => {
    // ── Task A — fails verify_tests, emitting failed_attempt for src/auth.ts.
    const taskA = await api<TaskResp>("POST", `/api/boards/${boardId}/tasks`, {
      title: "harden login auth flow",
      tddEnabled: true,
      tddPhase: "verify_tests",
      modelTier: "sonnet",
      likelyPaths: ["src/auth.ts"],
      // Keep §4.5 escalation out of it — this test is about the event log.
      loopPolicy: { escalation: { escalateAfterFailures: 99, thrashDetection: false } },
    });
    await api("POST", `/api/tasks/${taskA.id}/execute`);
    await pollFor(async () => {
      const list = await api<TaskResp[]>("GET", `/api/boards/${boardId}/tasks`);
      const t = list.find((r) => r.id === taskA.id);
      return t && ["blocked", "failed", "in_review"].includes(t.status) ? t : null;
    });

    // ── The event exists, and carries the file footprint.
    const db = new Database(dbPath, { readonly: true });
    const evRow = db.query(
      "SELECT type, subject, paths FROM knowledge_events WHERE task_id = ? AND type = 'failed_attempt' LIMIT 1",
    ).get(taskA.id) as { type: string; subject: string; paths: string } | null;

    expect(evRow).not.toBeNull();
    // The regression this test exists for: paths must not be empty. An event
    // with [] is invisible to the governance gate and to §J's edge builder.
    expect(JSON.parse(evRow!.paths)).toEqual(["src/auth.ts"]);

    // ── Task B — same file footprint, no shared text beyond the domain.
    const taskB = await api<TaskResp>("POST", `/api/boards/${boardId}/tasks`, {
      title: "add session expiry to login",
      likelyPaths: ["src/auth.ts"],
    });
    await api("POST", `/api/tasks/${taskB.id}/execute`);

    const pack = await pollFor(async () => {
      const row = db.query(
        "SELECT system_prompt FROM executions WHERE task_id = ? AND system_prompt IS NOT NULL LIMIT 1",
      ).get(taskB.id) as { system_prompt: string } | null;
      return row?.system_prompt ?? null;
    });

    // (a) §4.3 — the prior failure was retrieved into the pack.
    expect(pack).toContain("## Related team knowledge");
    expect(pack).toContain("harden login auth flow");

    // (b) §4.5 — the governance gate fired on the shared file.
    expect(pack).toContain("Governance warnings");
    expect(pack).toContain("src/auth.ts");

    db.close();
  }, 60000);
});
