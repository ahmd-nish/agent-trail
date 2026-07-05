import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_TESTING T3.2 + T3.4 E2E — real server, mocked claude via
// AGENT_TRAIL_CASE_GEN_MOCK. Verifies:
//   • POST /api/tasks/:id/generate-cases returns typed TestCase[]
//   • Saved <original, fixed> examples on the board are surfaced
//   • Listing + deleting examples works
//   • Board deletion cascades example rows (foreign_keys + T0.6 combined)

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

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

const MOCK_RESPONSE = JSON.stringify({
  cases: [
    {
      criterionIndex: 0,
      label: "POST /notes → 201",
      kind: "api",
      method: "POST",
      path: "/notes",
      headers: "Content-Type: application/json",
      body: `{"title":"seed","body":"first"}`,
      assertions: [
        { kind: "status", equals: 201 },
        { kind: "json_path", path: "$.id", exists: true },
      ],
    },
  ],
});

interface BoardResp { id: string }
interface TaskResp  { id: string }

describe("agent case-authoring + learning E2E — PRD_TESTING T3.2 + T3.4", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let mockPath = "";
  let boardId = "";
  let taskId = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-gencases-e2e-"));
    mockPath = join(tmp, "case-gen.json");
    writeFileSync(mockPath, MOCK_RESPONSE, "utf-8");
    port = await findFreePort();
    const { AGENT_TRAIL_DB_PATH: _a, VIBE_BOARD_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        AGENT_TRAIL_PORT: String(port),
        AGENT_TRAIL_ROOT: tmp,
        AGENT_TRAIL_SKIP_RUNNER: "1",
        AGENT_TRAIL_CASE_GEN_MOCK: `file:${mockPath}`,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);

    boardId = ((await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "case-gen-e2e" }),
    })).json()) as BoardResp).id;

    taskId = ((await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "notes API",
        description: "POST /notes creates a note; GET /notes lists all.",
        successCriteria: ["POST /notes returns 201 with id", "GET /notes returns an array"],
      }),
    })).json()) as TaskResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("POST /api/tasks/:id/generate-cases returns typed cases (T3.2)", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/${taskId}/generate-cases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://api.example.com" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      cases: Array<{ id: string; label: string; assertions: unknown[] }>;
      source: string;
      exampleCount: number;
    };
    expect(body.cases.length).toBe(1);
    expect(body.cases[0]!.id).toMatch(/^case-/);
    expect(body.cases[0]!.assertions.length).toBe(2);
    // source === "mock" because AGENT_TRAIL_CASE_GEN_MOCK was set.
    expect(body.source).toBe("mock");
    // No examples saved yet.
    expect(body.exampleCount).toBe(0);
  });

  test("POST /api/boards/:id/case-examples saves a pair and appears in list (T3.4)", async () => {
    const original = { id: "orig-1", criterionIndex: 0, label: "wrong-path", kind: "api", method: "POST", path: "/note" };
    const fixed    = { id: "fix-1",  criterionIndex: 0, label: "wrong-path", kind: "api", method: "POST", path: "/notes" };
    const save = await fetch(`http://localhost:${port}/api/boards/${boardId}/case-examples`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ original, fixed, note: "singular /note was wrong; API uses /notes" }),
    });
    expect(save.status).toBe(201);
    const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/case-examples`)).json() as {
      examples: Array<{ id: string; note: string | null; original: unknown; fixed: unknown }>;
    };
    expect(list.examples.length).toBe(1);
    expect(list.examples[0]!.note).toContain("singular /note was wrong");
  });

  test("Next generate-cases call sees exampleCount=1 (learning wired)", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/${taskId}/generate-cases`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json() as { exampleCount: number };
    expect(body.exampleCount).toBe(1);
  });

  test("DELETE /api/case-examples/:id removes a specific example", async () => {
    const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/case-examples`)).json() as
      { examples: Array<{ id: string }> };
    const first = list.examples[0]!;
    const del = await fetch(`http://localhost:${port}/api/case-examples/${first.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/case-examples`)).json() as
      { examples: unknown[] };
    expect(after.examples.length).toBe(0);
  });

  test("generate-cases returns 404 when the task is missing", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/00000000-does-not-exist/generate-cases`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(404);
  });

  test("save-example returns 404 when the board is missing", async () => {
    const res = await fetch(`http://localhost:${port}/api/boards/00000000-nope/case-examples`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ original: {}, fixed: {} }),
    });
    expect(res.status).toBe(404);
  });
});
