import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE §5.6 — deploy agent E2E.
// Uses a shell command that writes a sentinel file so we can verify the
// deploy actually ran. `--auto-confirm` skips the ticket for the E2E; the
// gated path is exercised via the /confirm endpoint separately.

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
interface TargetRow { id: string; name: string; command: string }
interface DeployRow { id: string; status: string }

describe("deploy agent — PRD §5.6", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let workDir = "";
  let boardId = "";
  let sentinel = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-deploy-e2e-"));
    workDir = join(tmp, "work");
    mkdirSync(workDir, { recursive: true });
    sentinel = join(tmp, "deployed.txt");
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
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
    boardId = (await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "deploy-board", implementationDir: workDir }),
    })).json() as BoardResp).id;
  }, 30000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("POST/GET/DELETE /deploy-targets round-trips", async () => {
    const create = await fetch(`http://localhost:${port}/api/boards/${boardId}/deploy-targets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "temp", command: "true" }),
    });
    expect(create.status).toBe(201);
    const t = await create.json() as TargetRow;
    const list = await (await fetch(`http://localhost:${port}/api/boards/${boardId}/deploy-targets`)).json() as TargetRow[];
    expect(list.some((r) => r.id === t.id)).toBe(true);
    const del = await fetch(`http://localhost:${port}/api/deploy-targets/${t.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  test("autoConfirm deploy — command runs, sentinel file lands, status=success", async () => {
    // Create a target that writes a sentinel when it runs.
    const create = await fetch(`http://localhost:${port}/api/boards/${boardId}/deploy-targets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "sentinel",
        command: `echo "shipped $(date +%s)" > ${sentinel}`,
      }),
    });
    expect(create.status).toBe(201);

    const kick = await fetch(`http://localhost:${port}/api/boards/${boardId}/deploy`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetName: "sentinel", autoConfirm: true }),
    });
    expect(kick.status).toBe(202);
    const { deployId } = await kick.json() as { deployId: string };

    // Poll until terminal.
    const final = await pollFor(async () => {
      const row = await (await fetch(`http://localhost:${port}/api/deploys/${deployId}`)).json() as DeployRow;
      return row.status !== "pending" && row.status !== "running" ? row : null;
    });
    expect(final.status).toBe("success");
    expect(existsSync(sentinel)).toBe(true);
  }, 30000);

  test("gated deploy — raises a decision ticket, confirm endpoint runs it", async () => {
    const target2 = join(tmp, "gated.txt");
    await fetch(`http://localhost:${port}/api/boards/${boardId}/deploy-targets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "gated",
        command: `echo gated > ${target2}`,
      }),
    });
    const kick = await fetch(`http://localhost:${port}/api/boards/${boardId}/deploy`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetName: "gated" /* autoConfirm defaults to false */ }),
    });
    const body = await kick.json() as { deployId: string; ticketId?: string; requiresConfirmation: boolean };
    expect(body.requiresConfirmation).toBe(true);
    expect(existsSync(target2)).toBe(false); // NOT run yet

    // Fire the confirm endpoint (mimics the user answering the ticket).
    const conf = await fetch(`http://localhost:${port}/api/deploys/${body.deployId}/confirm`, { method: "POST" });
    expect(conf.status).toBe(200);
    const result = await conf.json() as { deployId: string; ok: boolean; status: string };
    expect(result.ok).toBe(true);
    expect(result.status).toBe("success");
    expect(existsSync(target2)).toBe(true);

    // Confirm is a one-shot — a second attempt is 409.
    const second = await fetch(`http://localhost:${port}/api/deploys/${body.deployId}/confirm`, { method: "POST" });
    expect(second.status).toBe(409);
  }, 30000);
});
