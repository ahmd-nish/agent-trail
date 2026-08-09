import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD 1.8 — subagent library v0.
// Acceptance:
//   • .claude/agents/ + .mcp.json auto-discovery      → /api/agents lists both project + bundled
//   • 6 bundled subagents                             → each returns from a fresh cwd
//   • picker UI on task                               → covered by web unit; API surface asserted here
//   • project overrides bundled by `name`             → same-name project entry wins

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const BUNDLED_NAMES = [
  "tdd-implementer",
  "test-writer",
  "frontend-implementer",
  "api-implementer",
  "db-migrator",
  "refactorer",
];

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

interface AgentEntry {
  name: string; description: string; tools: string[];
  source: "project" | "monorepo" | "bundled"; path: string;
}

describe("agent library discovery E2E — PRD 1.8", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-agents-e2e-"));
    // Seed a project-level agent + an override for `tdd-implementer`.
    const agentsDir = join(tmp, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "project-custom.md"), `---
name: project-custom
description: A project-scoped agent for the E2E test.
tools: Read, Bash
---

You are the project-custom agent.
`, "utf-8");

    writeFileSync(join(agentsDir, "tdd-implementer.md"), `---
name: tdd-implementer
description: PROJECT OVERRIDE — differs from the bundled description.
tools: Read
---

Project override body.
`, "utf-8");

    port = await findFreePort();
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        INVENTARIUM_PORT: String(port),
        INVENTARIUM_ROOT: tmp,
        INVENTARIUM_SKIP_RUNNER: "1",
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

  test("GET /api/agents lists bundled agents + project agents", async () => {
    const entries = await (await fetch(`http://localhost:${port}/api/agents`)).json() as AgentEntry[];
    const names = new Set(entries.map((e) => e.name));
    for (const b of BUNDLED_NAMES) expect(names.has(b)).toBe(true);
    expect(names.has("project-custom")).toBe(true);
    // Every entry has description + tools[].
    for (const e of entries) {
      expect(typeof e.description).toBe("string");
      expect(Array.isArray(e.tools)).toBe(true);
    }
  });

  test("project agent with the same name overrides the bundled one", async () => {
    const entries = await (await fetch(`http://localhost:${port}/api/agents`)).json() as AgentEntry[];
    const tdd = entries.find((e) => e.name === "tdd-implementer")!;
    expect(tdd).toBeTruthy();
    expect(tdd.source).toBe("project");
    expect(tdd.description).toBe("PROJECT OVERRIDE — differs from the bundled description.");
  });

  test("GET /api/agents/:name returns the full body of a bundled agent", async () => {
    const res = await fetch(`http://localhost:${port}/api/agents/test-writer`);
    expect(res.status).toBe(200);
    const body = await res.json() as AgentEntry & { body: string };
    expect(body.name).toBe("test-writer");
    expect(body.body).toContain("Rules");
  });

  test("GET /api/agents/:name returns 404 for an unknown agent", async () => {
    const res = await fetch(`http://localhost:${port}/api/agents/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("PATCH /api/tasks/:id { subagents } persists the array (picker save path)", async () => {
    const boardId = ((await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "agents-e2e" }),
    })).json()) as { id: string }).id;

    const task = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "picker-target" }),
    })).json() as { id: string; subagents: string[] };
    expect(task.subagents).toEqual([]);

    const updated = await fetch(`http://localhost:${port}/api/tasks/${task.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subagents: ["tdd-implementer", "refactorer"] }),
    });
    expect(updated.status).toBe(200);
    const patched = await updated.json() as { subagents: string[] };
    expect(patched.subagents).toEqual(["tdd-implementer", "refactorer"]);

    // Round-trip via list to prove it was persisted, not just echoed.
    const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/tasks`)).json() as Array<{ id: string; subagents: string[] }>;
    const found = list.find((t) => t.id === task.id)!;
    expect(found.subagents).toEqual(["tdd-implementer", "refactorer"]);
  });
});
