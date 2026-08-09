import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// End-to-end: real server → /api/boards/plan → planner (with mocked runner)
// → DAG → DB. Verifies PRD 1.2 acceptance:
//   • sample PRD produces a valid task graph
//   • deps resolve, parallel groups exist
//   • schema-validation retry ≤ 2 (planner gives up on 3 bad responses)
//
// One server for the whole file — cheaper on CI and dodges cold-spawn
// contention when the full suite runs in parallel. Each test rewrites the
// planner-mock fixture file before making its request.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const SAMPLE_PRD_PATH = join(import.meta.dir, "../../../examples/sample-prd.md");

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
    } catch { /* try again */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const GOOD_GRAPH = JSON.stringify({
  tasks: [
    { id: "schema", title: "Design SQLite schema", description: "Notes + tags + join table", priority: "high", tddEnabled: true, dependsOn: [] },
    { id: "crud-notes", title: "Build CRUD for notes", description: "POST/GET/PATCH/DELETE /notes", priority: "high", tddEnabled: true, dependsOn: ["schema"] },
    { id: "crud-tags", title: "Build CRUD for tags", description: "POST/GET/DELETE /tags", priority: "high", tddEnabled: true, dependsOn: ["schema"] },
    { id: "attach-tags", title: "Attach/detach tag to note", description: "join table endpoints", priority: "medium", tddEnabled: true, dependsOn: ["crud-notes", "crud-tags"] },
    { id: "search", title: "Full-text search endpoint", description: "GET /search?q=", priority: "medium", tddEnabled: true, dependsOn: ["crud-notes"] },
  ],
});

const BAD_GRAPH = JSON.stringify({ tasks: "definitely-not-an-array" });

describe("plan E2E — PRD 1.2", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let mockPath = "";
  let samplePrd = "";

  beforeAll(async () => {
    samplePrd = readFileSync(SAMPLE_PRD_PATH, "utf-8");
    tmp = mkdtempSync(join(tmpdir(), "at-plan-e2e-"));
    mockPath = join(tmp, "planner-mock.json");
    writeFileSync(mockPath, GOOD_GRAPH, "utf-8");
    port = await findFreePort();
    // Snapshot env but strip DB-path overrides that other tests may have set —
    // otherwise we open a leaked path from `paths.test.ts` which is unwritable.
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        INVENTARIUM_PORT: String(port),
        INVENTARIUM_ROOT: tmp,
        INVENTARIUM_SKIP_RUNNER: "1",
        INVENTARIUM_PLANNER_MOCK: `file:${mockPath}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}\n---child output---\n${out.slice(0, 2000)}`);
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("POST /api/boards/plan returns a valid DAG with parallel groups", async () => {
    writeFileSync(mockPath, GOOD_GRAPH, "utf-8");
    const res = await fetch(`http://localhost:${port}/api/boards/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prdText: samplePrd, name: "Notes API" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      board: { id: string; name: string };
      tasks: Array<{
        id: string;
        title: string;
        dependsOn: string[];
        parallelGroup: string | null;
        modelTier: string | null;
      }>;
    };

    expect(body.board.name).toBe("Notes API");
    expect(body.tasks.length).toBe(5);

    for (const t of body.tasks) {
      expect(t.parallelGroup).toBeTruthy();
      expect(typeof t.parallelGroup).toBe("string");
      // PRD 1.9: planner suggests a tier for every task.
      expect(t.modelTier).toBeTruthy();
      expect(["haiku", "sonnet", "opus"]).toContain(t.modelTier);
    }

    const groupCounts = new Map<string, number>();
    for (const t of body.tasks) {
      const g = t.parallelGroup!;
      groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
    }
    const maxGroupSize = Math.max(...groupCounts.values());
    expect(maxGroupSize).toBeGreaterThanOrEqual(2);

    const ids = new Set(body.tasks.map((t) => t.id));
    for (const t of body.tasks) {
      for (const dep of t.dependsOn) expect(ids.has(dep)).toBe(true);
    }
  });

  test("planner retries ≤2 times then surfaces the error", async () => {
    writeFileSync(mockPath, BAD_GRAPH, "utf-8");
    const res = await fetch(`http://localhost:${port}/api/boards/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prdText: "# tiny\n\nsome text", name: "will-fail" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("dry-run returns tasks without writing to DB", async () => {
    writeFileSync(mockPath, GOOD_GRAPH, "utf-8");
    const boardsBefore = await (await fetch(`http://localhost:${port}/api/boards`)).json() as unknown[];

    const res = await fetch(`http://localhost:${port}/api/boards/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prdText: samplePrd, name: "temp", dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { board: unknown; tasks: unknown[]; dryRun: boolean };
    expect(body.dryRun).toBe(true);
    expect(body.board).toBeNull();
    expect(body.tasks.length).toBe(5);

    const boardsAfter = await (await fetch(`http://localhost:${port}/api/boards`)).json() as unknown[];
    expect(boardsAfter.length).toBe(boardsBefore.length);
  });

  test("non-dry-run persists tasks to DB and lists them via /tasks endpoint", async () => {
    writeFileSync(mockPath, GOOD_GRAPH, "utf-8");
    const planRes = await fetch(`http://localhost:${port}/api/boards/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prdText: samplePrd, name: "Persist Notes" }),
    });
    expect(planRes.status).toBe(200);
    const plan = await planRes.json() as { board: { id: string; name: string }; tasks: Array<{ id: string }> };
    expect(plan.board.name).toBe("Persist Notes");

    const listed = await (await fetch(`http://localhost:${port}/api/boards/${plan.board.id}/tasks`)).json() as Array<{ id: string; title: string }>;
    expect(listed.length).toBe(plan.tasks.length);
    const listedIds = new Set(listed.map((t) => t.id));
    for (const t of plan.tasks) expect(listedIds.has(t.id)).toBe(true);
  });
});
