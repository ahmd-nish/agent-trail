import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// Spins the real server in an isolated CWD to verify the new static-hosting +
// port-plumbing plumbing for the `npx agent-trail` (1.1) launch path.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const WEB_DIST_INDEX = join(import.meta.dir, "../../web/dist/index.html");

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

async function waitForHealth(port: number, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(400) });
      if (r.ok) return true;
    } catch { /* try again */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("server static hosting (npx launch path)", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";

  beforeAll(async () => {
    if (!(await Bun.file(WEB_DIST_INDEX).exists())) {
      throw new Error(`Web build missing at ${WEB_DIST_INDEX}. Run: bun run -F @agent-trail/web build`);
    }
    tmp = mkdtempSync(join(tmpdir(), "agent-trail-test-"));
    port = await findFreePort();
    // Strip DB-path env overrides from other tests (see plan-e2e.test.ts).
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
  });

  afterAll(() => {
    child?.kill("SIGTERM");
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("GET / serves the SPA index.html", async () => {
    const r = await fetch(`http://localhost:${port}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const body = await r.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("<div id=\"root\">");
  });

  test("unknown route falls back to index.html (SPA routing)", async () => {
    const r = await fetch(`http://localhost:${port}/board/anything/settings`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("<div id=\"root\">");
  });

  test("api routes are NOT shadowed by the static handler", async () => {
    const health = await fetch(`http://localhost:${port}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);

    const missing = await fetch(`http://localhost:${port}/api/definitely-not-a-route`);
    expect(missing.status).toBe(404);
    // A missing API route must return JSON/text, NOT the SPA html.
    const body = await missing.text();
    expect(body).not.toContain("<div id=\"root\">");
  });

  test("path-traversal via ../ is refused", async () => {
    const r = await fetch(`http://localhost:${port}/../../../etc/passwd`);
    // URL parsing normalises this on the client, so we hit the encoded form too.
    const r2 = await fetch(`http://localhost:${port}/%2e%2e/%2e%2e/etc/passwd`);
    // Either a 403 or a fallback-to-index.html is acceptable; a leak is not.
    for (const resp of [r, r2]) {
      const body = await resp.text();
      expect(body).not.toContain("root:x:");
    }
  });

  test("static asset serves with long cache header", async () => {
    // Discover the built asset filename from the index.
    const indexBody = await (await fetch(`http://localhost:${port}/`)).text();
    const match = indexBody.match(/src="(\/assets\/[^"]+\.js)"/);
    expect(match).toBeTruthy();
    if (!match) return;
    const assetUrl = match[1];
    const r = await fetch(`http://localhost:${port}${assetUrl}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(r.headers.get("cache-control") ?? "").toContain("max-age=31536000");
  });
});
