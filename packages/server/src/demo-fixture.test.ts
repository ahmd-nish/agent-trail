import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD 1.12 acceptance: demo replay fixture is fetchable from the same origin
// the SPA served from — no CORS, no extra hosting needed. Also asserts the
// fixture's shape matches the DemoPlayer expectations.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const FIXTURE_PATH = join(import.meta.dir, "../../web/dist/demo-fixture.json");

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

describe("demo fixture (PRD 1.12)", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";

  beforeAll(async () => {
    if (!(await Bun.file(FIXTURE_PATH).exists())) {
      throw new Error(`Demo fixture missing at ${FIXTURE_PATH}. Run: bun run -F @agent-trail/web build`);
    }
    tmp = mkdtempSync(join(tmpdir(), "at-demo-e2e-"));
    port = await findFreePort();
    const { AGENT_TRAIL_DB_PATH: _a, VIBE_BOARD_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        AGENT_TRAIL_PORT: String(port),
        AGENT_TRAIL_ROOT: tmp,
        AGENT_TRAIL_SKIP_RUNNER: "1",
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("GET /demo-fixture.json returns JSON with the expected shape", async () => {
    const res = await fetch(`http://localhost:${port}/demo-fixture.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("json");
    const body = await res.json() as {
      board: { id: string; name: string };
      tasks: Array<{ id: string; title: string; dependsOn: string[] }>;
      timeline: Array<{ delayMs: number; action: string }>;
    };

    expect(body.board.id).toBe("demo-board");
    expect(body.board.name.length).toBeGreaterThan(0);
    expect(body.tasks.length).toBeGreaterThanOrEqual(3);
    for (const t of body.tasks) {
      expect(t.id).toBeString();
      expect(t.title).toBeString();
      expect(Array.isArray(t.dependsOn)).toBe(true);
    }
    expect(body.timeline.length).toBeGreaterThan(10);
  });

  test("timeline includes a decision-ticket pause and completion events", async () => {
    const body = await (await fetch(`http://localhost:${port}/demo-fixture.json`)).json() as {
      timeline: Array<{ action: string; event?: { type: string } }>;
    };
    const actions = body.timeline.map((t) => t.action);
    expect(actions).toContain("ask_human");
    const eventTypes = body.timeline
      .filter((t) => t.action === "sse")
      .map((t) => t.event?.type);
    expect(eventTypes).toContain("execution_complete");
    expect(eventTypes).toContain("test_result");
    expect(eventTypes).toContain("tool_call");
  });

  test("all timeline events reference real task IDs", async () => {
    const body = await (await fetch(`http://localhost:${port}/demo-fixture.json`)).json() as {
      tasks: Array<{ id: string }>;
      timeline: Array<{ taskId: string }>;
    };
    const ids = new Set(body.tasks.map((t) => t.id));
    for (const entry of body.timeline) expect(ids.has(entry.taskId)).toBe(true);
  });

  test("all dependsOn references resolve to real task IDs", async () => {
    const body = await (await fetch(`http://localhost:${port}/demo-fixture.json`)).json() as {
      tasks: Array<{ id: string; dependsOn: string[] }>;
    };
    const ids = new Set(body.tasks.map((t) => t.id));
    for (const t of body.tasks) {
      for (const dep of t.dependsOn) expect(ids.has(dep)).toBe(true);
    }
  });
});
