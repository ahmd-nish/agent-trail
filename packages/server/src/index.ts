import { Hono } from "hono";
import { cors } from "hono/cors";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { boardsRouter } from "./routes/boards.ts";
import { tasksRouter } from "./routes/tasks.ts";
import { executionsRouter } from "./routes/executions.ts";
import { decisionsRouter } from "./routes/decisions.ts";
import { artifactsRouter } from "./routes/artifacts.ts";
import { exportRouter } from "./routes/export.ts";
import { planRouter } from "./routes/plan.ts";
import { examplesRouter } from "./routes/examples.ts";
import { agentsRouter } from "./routes/agents.ts";
import { testExecutionRouter } from "./routes/test-execution.ts";
import { testHistoryRouter } from "./routes/test-history.ts";
import { devServerRouter } from "./routes/dev-server.ts";
import { getDb } from "./db.ts";
import { executionManager } from "./execution-manager.ts";
import { resolveProjectRoot } from "../../core/src/storage/paths.ts";

const RUNNER_URL = process.env["AGENT_TRAIL_RUNNER_URL"] ?? process.env["VIBE_BOARD_RUNNER_URL"] ?? "http://localhost:3003";
const PROJECT_ROOT = resolveProjectRoot();
const RUNNER_ENTRY = join(import.meta.dir, "../../runner/src/index.ts");
const WEB_DIST_CANDIDATES = [
  join(import.meta.dir, "../../web/dist"),
  join(import.meta.dir, "../web/dist"),
  join(import.meta.dir, "../../../web/dist"),
];
const WEB_DIST = WEB_DIST_CANDIDATES.find((p) => existsSync(join(p, "index.html")));

async function ensureRunner(): Promise<void> {
  if (process.env["AGENT_TRAIL_SKIP_RUNNER"] === "1") {
    // Tests + `npx agent-trail` on machines without dev-server needs opt out.
    return;
  }
  try {
    const res = await fetch(`${RUNNER_URL}/health`, { signal: AbortSignal.timeout(800) });
    if (res.ok) return;
  } catch { /* not up yet */ }

  if (!existsSync(RUNNER_ENTRY)) {
    console.warn("[server] runner entry not found — dev server features disabled");
    return;
  }
  console.log(`[server] runner not found at ${RUNNER_URL} — auto-spawning…`);
  const child = spawn("bun", [RUNNER_ENTRY], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    detached: true,
  });
  child.unref();

  // Wait up to 3 s for the runner to bind
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`${RUNNER_URL}/health`, { signal: AbortSignal.timeout(400) });
      if (res.ok) { console.log("[server] runner ready"); return; }
    } catch { /* still starting */ }
  }
  console.warn("[server] runner did not become ready in time — dev server features may not work");
}

const app = new Hono();

app.use("*", cors({ origin: ["http://localhost:5173", "http://localhost:5174"], credentials: true }));

// Health check
app.get("/api/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Routers
app.route("/api/boards", boardsRouter);
app.route("/api", tasksRouter);
app.route("/api", executionsRouter);
app.route("/api", decisionsRouter);
app.route("/api", artifactsRouter);
app.route("/api", exportRouter);
app.route("/api/boards", planRouter);
app.route("/api", examplesRouter);
app.route("/api", agentsRouter);
app.route("/api", testExecutionRouter);
app.route("/api", testHistoryRouter);
app.route("/api", devServerRouter);

// ─── Static web UI (served when packaged; dev uses vite on 5173) ─────────────
if (WEB_DIST) {
  const distRoot = resolve(WEB_DIST);
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico":  "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".woff": "font/woff",
    ".woff2":"font/woff2",
    ".map":  "application/json",
  };

  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith("/api/")) return c.notFound();
    let rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!rel) rel = "index.html";
    const candidate = normalize(join(distRoot, rel));
    // path-traversal guard
    if (!candidate.startsWith(distRoot)) return c.text("Forbidden", 403);

    let filePath = candidate;
    let exists = false;
    try {
      const st = statSync(filePath);
      exists = st.isFile();
    } catch { exists = false; }

    if (!exists) {
      // SPA fallback → index.html so client-side routes work
      filePath = join(distRoot, "index.html");
    }

    const ext = filePath.slice(filePath.lastIndexOf("."));
    const type = mime[ext] ?? "application/octet-stream";
    const body = readFileSync(filePath);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": type,
        "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
      },
    });
  });
} else {
  console.log("[server] web dist not found — run `bun run -F @agent-trail/web build` or use vite on :5173");
}

// Initialize DB on startup + recover orphan executions from a prior crash.
getDb();
executionManager.recoverFromCrash();
ensureRunner();

const port = Number(process.env["AGENT_TRAIL_PORT"] ?? process.env["PORT"] ?? 3002);
console.log(`agent-trail server running on http://localhost:${port}`);

export default { port, fetch: app.fetch };
