import { Hono } from "hono";
import { cors } from "hono/cors";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { boardsRouter } from "./routes/boards.ts";
import { relayRouter } from "./routes/relay.ts";
import { knowledgeGraphRouter } from "./routes/knowledge-graph.ts";
import { tasksRouter } from "./routes/tasks.ts";
import { executionsRouter } from "./routes/executions.ts";
import { decisionsRouter } from "./routes/decisions.ts";
import { artifactsRouter } from "./routes/artifacts.ts";
import { exportRouter } from "./routes/export.ts";
import { planRouter } from "./routes/plan.ts";
import { examplesRouter } from "./routes/examples.ts";
import { agentsRouter } from "./routes/agents.ts";
import { ideasRouter } from "./routes/ideas.ts";
import { libraryRouter } from "./routes/library.ts";
import { steeringRouter } from "./routes/steering.ts";
import { deployRouter } from "./routes/deploy.ts";
import { testExecutionRouter } from "./routes/test-execution.ts";
import { testHistoryRouter } from "./routes/test-history.ts";
import { devServerRouter } from "./routes/dev-server.ts";
import { getDb } from "./db.ts";
import { executionManager } from "./execution-manager.ts";
import { resolveDbPath, resolveProjectRoot } from "../../core/src/storage/paths.ts";
import { hydrateFromFile, startAutoSync } from "../../core/src/context/sync.ts";

const RUNNER_URL = process.env["AGENT_TRAIL_RUNNER_URL"] ?? process.env["VIBE_BOARD_RUNNER_URL"] ?? "http://localhost:3003";
// AGENT_TRAIL_PROJECT_ROOT overrides the cwd-derived root. This is the knob
// that lets sandboxes / demos / tests aim state.json at a specific directory
// independent of where the server was launched from.
const PROJECT_ROOT = process.env["AGENT_TRAIL_PROJECT_ROOT"] ?? resolveProjectRoot();
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
// §4.6 relay — mounted at root, not under /api, because it is a distinct
// protocol surface consumed by other agent-trail installs rather than by the
// local UI. Disabled unless AGENT_TRAIL_RELAY_TOKEN is set.
app.route("/", relayRouter);
app.route("/api", knowledgeGraphRouter);
app.route("/api", tasksRouter);
app.route("/api", executionsRouter);
app.route("/api", decisionsRouter);
app.route("/api", artifactsRouter);
app.route("/api", exportRouter);
app.route("/api/boards", planRouter);
app.route("/api", examplesRouter);
app.route("/api", agentsRouter);
app.route("/api", ideasRouter);
app.route("/api", libraryRouter);
app.route("/api", steeringRouter);
app.route("/api", deployRouter);
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
const db = getDb();
executionManager.recoverFromCrash();
ensureRunner();

// PRD_OPEN_SOURCE §3.1 — team-context sync. Hydrate the DB from
// `.agent-trail/state.json` (a teammate cloned the repo and is booting for
// the first time), then start the auto-writer so future mutations flow back
// to disk. Both are no-ops when the file doesn't exist / nothing changed.
//
// Isolation contract:
//   - AGENT_TRAIL_SKIP_HYDRATE=1     → skip hydration entirely
//   - AGENT_TRAIL_SKIP_AUTOSYNC=1    → skip the write-back tick (already existed)
//   - Safety net: if AGENT_TRAIL_DB_PATH points *outside* PROJECT_ROOT, refuse
//     to hydrate/autosync — a sandbox at /tmp/x/db.sqlite must not inherit or
//     stomp on the real repo's state.json. Warn with a fix-it message.
const skipHydrate = process.env["AGENT_TRAIL_SKIP_HYDRATE"] === "1";
const skipAutosync = process.env["AGENT_TRAIL_SKIP_AUTOSYNC"] === "1";
// If AGENT_TRAIL_PROJECT_ROOT is set the user has explicitly bound the DB
// to a project, so honor it. Otherwise fall back to the disjoint-paths
// safety net which catches the naive "AGENT_TRAIL_DB_PATH=/tmp/..." case.
const projectRootExplicit = process.env["AGENT_TRAIL_PROJECT_ROOT"] !== undefined;
const stateJsonAllowed = skipHydrate
  ? false
  : projectRootExplicit || dbBelongsToProject(PROJECT_ROOT);
if (skipHydrate) {
  console.log("[state-sync] AGENT_TRAIL_SKIP_HYDRATE=1 — hydration skipped");
} else if (!stateJsonAllowed) {
  console.warn(
    `[state-sync] SKIPPING hydrate — DB (${process.env["AGENT_TRAIL_DB_PATH"] ?? resolveDbPath(PROJECT_ROOT)}) is not inside ` +
    `project root (${PROJECT_ROOT}). Set AGENT_TRAIL_PROJECT_ROOT to bind them, or ` +
    `AGENT_TRAIL_SKIP_HYDRATE=1 to silence this.`,
  );
} else {
  try {
    const hydrated = hydrateFromFile(db, PROJECT_ROOT);
    if (hydrated && !hydrated.skippedVersion) {
      console.log(`[state-sync] hydrated ${hydrated.boardsUpserted} board(s), ${hydrated.tasksUpserted} task(s) from state.json`);
    } else if (hydrated?.skippedVersion) {
      console.warn("[state-sync] state.json schema version unknown — leaving DB untouched");
    }
  } catch (err) {
    console.warn(`[state-sync] hydrate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (!skipAutosync && stateJsonAllowed) {
  const intervalMs = Number(process.env["AGENT_TRAIL_AUTOSYNC_MS"] ?? 2000);
  startAutoSync(db, PROJECT_ROOT, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 2000);
}

// Returns true when the DB the server is writing to sits inside the project
// root the server is hydrating from. False = disjoint locations; either the
// caller has explicitly opted into a sandbox (AGENT_TRAIL_DB_PATH set to a
// scratch dir) or something is misconfigured. Either way, skipping the sync
// is the safe default — the user can opt back in via AGENT_TRAIL_PROJECT_ROOT.
function dbBelongsToProject(projectRoot: string): boolean {
  const explicitDbPath = process.env["AGENT_TRAIL_DB_PATH"] ?? process.env["VIBE_BOARD_DB_PATH"];
  if (!explicitDbPath) return true; // implicit default — DB sits under projectRoot by construction
  try {
    const dbDir = realpathSync(dirname(resolve(explicitDbPath)));
    const projDir = realpathSync(resolve(projectRoot));
    const rel = relative(projDir, dbDir);
    // If rel starts with ".." or is absolute, dbDir sits outside projDir.
    return !!rel && !rel.startsWith("..") && !resolve(rel).startsWith("/");
  } catch {
    // Missing dirs → be conservative and skip.
    return false;
  }
}

const port = Number(process.env["AGENT_TRAIL_PORT"] ?? process.env["PORT"] ?? 3002);
console.log(`agent-trail server running on http://localhost:${port}`);

export default { port, fetch: app.fetch };
