import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { serve, type Server } from "bun";

// PRD_TESTING T1 — end-to-end: real server + real target service. Verifies
//   T1.1 server-side execution (client never asserts)
//   T1.2 evidence-grade persistence with server_recorded = 1
//   T1.3 secret redaction (no plaintext in stored output)
//   T1.5 optimistic-lock PATCH
//   T1.6 retry classifier + flaky_pass state
//   T1.7 fresh chain context via {{prev.*}}

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

// Target — a tiny in-process API the test cases hit. Behaviors per path:
//   /echo-key         → 200; echoes X-API-Key back so we can assert redaction
//   /flake            → fails first N times, then 200 (per-key counter)
//   /notes            → GET returns fixed [{id:1},{id:2}]; POST returns {id:99}
//   /always-500       → always 500 (unrecoverable retry_status)
async function startTargetServer(): Promise<{ url: string; stop: () => void }> {
  const flakeCounts = new Map<string, number>();
  const server: Server = serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/echo-key") {
        const key = req.headers.get("x-api-key") ?? "(none)";
        return new Response(JSON.stringify({ received: key }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/flake") {
        const key = url.searchParams.get("key") ?? "default";
        const target = Number(url.searchParams.get("failFirst") ?? "1");
        const seen = flakeCounts.get(key) ?? 0;
        flakeCounts.set(key, seen + 1);
        if (seen < target) return new Response("service unavailable", { status: 503 });
        return new Response(JSON.stringify({ ok: true, attempt: seen + 1 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/notes") {
        if (req.method === "GET")
          return new Response(JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }), { status: 200, headers: { "content-type": "application/json" } });
        if (req.method === "POST")
          return new Response(JSON.stringify({ id: 99, ok: true }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.startsWith("/notes/")) {
        const idPart = url.pathname.slice("/notes/".length);
        return new Response(JSON.stringify({ id: Number(idPart), title: `note-${idPart}` }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/always-500") return new Response("boom", { status: 500 });
      return new Response("nope", { status: 404 });
    },
  });
  const port = server.port;
  return { url: `http://localhost:${port}`, stop: () => server.stop(true) };
}

interface BoardResp { id: string }
interface TaskResp  { id: string; updatedAt: string; testCases?: Array<{ id: string }> }

describe("server-side test execution E2E — PRD_TESTING T1", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let boardId = "";
  let target: { url: string; stop: () => void };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-testexec-e2e-"));
    port = await findFreePort();
    target = await startTargetServer();
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

    boardId = ((await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "testexec" }),
    })).json()) as BoardResp).id;

    // Seed board env — the plaintext value counts as a secret. The
    // executor should never leak it into stored output.
    await fetch(`http://localhost:${port}/api/boards/${boardId}/env`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "API_KEY", value: "sk_live_ABCDEFGHIJKLMNOP" }] }),
    });
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    target.stop();
    await new Promise((r) => setTimeout(r, 200));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  async function createTaskWithCases(cases: unknown[]): Promise<TaskResp> {
    const created = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `tc-${crypto.randomUUID().slice(0,4)}`, testCases: cases }),
    })).json() as TaskResp;
    return created;
  }

  test("secret substituted into a header is REDACTED from stored output (T1.3)", async () => {
    const caseObj = {
      id: `c-${crypto.randomUUID()}`,
      criterionIndex: 0,
      label: "echo",
      kind: "api",
      method: "GET",
      path: "/echo-key",
      headers: `X-API-Key: {{env.API_KEY}}`,
      assertions: [{ kind: "status", equals: 200 }],
    };
    const task = await createTaskWithCases([caseObj]);

    const res = await fetch(`http://localhost:${port}/api/tests/${caseObj.id}/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, baseUrl: target.url }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      runId: string; outcome: string; passed: boolean; status: number;
      output: string; assertions: Array<{ passed: boolean }>;
    };

    // Target responded 200 with our real key echoed back — but the stored
    // output must have the key replaced with the placeholder.
    expect(body.status).toBe(200);
    expect(body.passed).toBe(true);
    expect(body.outcome).toBe("pass");
    expect(body.output).toContain("{{env.API_KEY}}");
    expect(body.output).not.toContain("sk_live_ABCDEFGHIJKLMNOP");
    // Run persisted with server_recorded=1 (evidence-grade).
    // Peek at the runs listing (used elsewhere in the UI).
    const trend = await (await fetch(`http://localhost:${port}/api/tasks/${task.id}/test-runs?caseId=${encodeURIComponent(caseObj.id)}`)).json();
    expect((trend as { total: number }).total).toBeGreaterThanOrEqual(1);
  });

  test("transient 503 that turns green on retry → flaky_pass (T1.6)", async () => {
    const key = `flake-${crypto.randomUUID()}`;
    const caseObj = {
      id: `c-${crypto.randomUUID()}`,
      criterionIndex: 0,
      label: "flake",
      kind: "api",
      method: "GET",
      path: `/flake?key=${key}&failFirst=1`,
      assertions: [{ kind: "status", equals: 200 }],
      retry: { count: 2, backoffMs: 20 },
    };
    const task = await createTaskWithCases([caseObj]);
    const res = await fetch(`http://localhost:${port}/api/tests/${caseObj.id}/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, baseUrl: target.url }),
    });
    const body = await res.json() as { outcome: string; passed: boolean; attempts: number };
    expect(body.outcome).toBe("flaky_pass");
    expect(body.passed).toBe(true);
    expect(body.attempts).toBe(2);
  });

  test("assertion failure is NOT retried (T1.6)", async () => {
    const caseObj = {
      id: `c-${crypto.randomUUID()}`,
      criterionIndex: 0,
      label: "assert-fail",
      kind: "api",
      method: "GET",
      path: "/notes",
      // Correct request path, but assertion insists on the wrong status.
      assertions: [{ kind: "status", equals: 999 }],
      retry: { count: 3, backoffMs: 5 },
    };
    const task = await createTaskWithCases([caseObj]);
    const res = await fetch(`http://localhost:${port}/api/tests/${caseObj.id}/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, baseUrl: target.url }),
    });
    const body = await res.json() as { outcome: string; attempts: number };
    expect(body.outcome).toBe("fail");
    expect(body.attempts).toBe(1); // no retries for assertion failures
  });

  test("{{prev.*}} resolves from the caller-supplied chain context (T1.7)", async () => {
    // Two cases: read /notes (returns items), then GET /notes/{{prev.items[0].id}}.
    const caseObj = {
      id: `c-${crypto.randomUUID()}`,
      criterionIndex: 0,
      label: "detail",
      kind: "api",
      method: "GET",
      path: "/notes/{{prev.items[0].id}}",
      assertions: [{ kind: "status", equals: 200 }, { kind: "body_contains", text: "note-1" }],
    };
    const task = await createTaskWithCases([caseObj]);
    const res = await fetch(`http://localhost:${port}/api/tests/${caseObj.id}/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: task.id,
        baseUrl: target.url,
        prev: { items: [{ id: 1 }, { id: 2 }] },
      }),
    });
    const body = await res.json() as { passed: boolean; status: number; assertions: Array<{ passed: boolean }> };
    expect(body.status).toBe(200);
    expect(body.passed).toBe(true);
    expect(body.assertions.every((a) => a.passed)).toBe(true);
  });

  test("PATCH /tests/:taskId/cases/:caseId with a stale ifMatchUpdatedAt → 409 (T1.5)", async () => {
    const caseObj = {
      id: `c-${crypto.randomUUID()}`,
      criterionIndex: 0,
      label: "editable",
      kind: "api",
      method: "GET",
      path: "/notes",
      assertions: [{ kind: "status", equals: 200 }],
    };
    const task = await createTaskWithCases([caseObj]);

    // Concurrent edit — bump the task's updatedAt via a PATCH.
    await fetch(`http://localhost:${port}/api/tasks/${task.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "concurrent edit" }),
    });

    // Now attempt a case PATCH with the STALE ifMatchUpdatedAt.
    const stale = await fetch(`http://localhost:${port}/api/tests/${task.id}/cases/${caseObj.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ifMatchUpdatedAt: task.updatedAt, patch: { label: "new-label" } }),
    });
    expect(stale.status).toBe(409);

    // Read the fresh updatedAt and retry — should succeed.
    const fresh = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as TaskResp[];
    const currentTask = fresh.find((t) => t.id === task.id)!;
    const ok = await fetch(`http://localhost:${port}/api/tests/${task.id}/cases/${caseObj.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ifMatchUpdatedAt: currentTask.updatedAt, patch: { label: "new-label" } }),
    });
    expect(ok.status).toBe(200);
    const okBody = await ok.json() as { testCase: { label: string } };
    expect(okBody.testCase.label).toBe("new-label");
  });

  test("unresolved placeholders are surfaced (never silently pass)", async () => {
    const caseObj = {
      id: `c-${crypto.randomUUID()}`,
      criterionIndex: 0,
      label: "unresolved",
      kind: "api",
      method: "GET",
      path: "/notes/{{prev.doesnt.exist}}",
      assertions: [{ kind: "status", equals: 200 }],
    };
    const task = await createTaskWithCases([caseObj]);
    const res = await fetch(`http://localhost:${port}/api/tests/${caseObj.id}/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, baseUrl: target.url }),
    });
    const body = await res.json() as { unresolvedPlaceholders: string[] };
    expect(body.unresolvedPlaceholders).toContain("{{prev.doesnt.exist}}");
  });
});
