/**
 * Thin proxy from the public /api/boards/:id/dev/* surface to the runner
 * process (default :3003). The runner is the *only* place that spawns dev
 * server subprocesses — keeping the API server pure REST + SSE so a crash
 * here doesn't kill running dev servers.
 *
 * The runner is reachable at AGENT_TRAIL_RUNNER_URL (default http://localhost:3003).
 * If the runner is down, requests return 503 with a clear hint to start it.
 */

import { Hono } from "hono";
import { getDb, rowToBoard } from "../db.ts";
import { detectDevConfig } from "../dev-server-manager.ts";

const RUNNER_URL = process.env["AGENT_TRAIL_RUNNER_URL"] ?? process.env["VIBE_BOARD_RUNNER_URL"] ?? "http://localhost:3003";

export const devServerRouter = new Hono();

function loadBoard(boardId: string) {
  const db = getDb();
  const row = db.query("SELECT * FROM boards WHERE id = ?").get(boardId) as Parameters<typeof rowToBoard>[0] | null;
  return row ? rowToBoard(row) : null;
}

/** Forward a request to the runner. Returns a Response (passing status + body through). */
async function forward(path: string, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(`${RUNNER_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    return res;
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Runner unreachable",
        hint: `The agent-trail runner is not responding at ${RUNNER_URL}. Start it with \`bun runner\` (or \`bun start\`).`,
        details: err instanceof Error ? err.message : String(err),
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
}

devServerRouter.get("/boards/:boardId/dev/status", async (c) => {
  const res = await forward(`/dev/${c.req.param("boardId")}/status`);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

devServerRouter.get("/boards/:boardId/dev/detect", (c) => {
  const board = loadBoard(c.req.param("boardId"));
  if (!board) return c.json({ error: "Board not found" }, 404);
  if (!board.implementationDir) return c.json({ command: null, port: null, error: "No implementation_dir set" }, 400);
  return c.json(detectDevConfig(board.implementationDir));
});

devServerRouter.post("/boards/:boardId/dev/start", async (c) => {
  const { boardId } = c.req.param();
  const board = loadBoard(boardId);
  if (!board) return c.json({ error: "Board not found" }, 404);
  if (!board.implementationDir) return c.json({ error: "Set the board's implementation directory first" }, 400);

  const body = await c.req.json<{ command?: string; port?: number | null }>().catch(() => ({}));
  const command = (body.command ?? board.devCommand ?? "").trim();
  const port = body.port ?? board.devPort ?? null;
  if (!command) return c.json({ error: "No dev command configured." }, 400);

  // Mirror chosen command/port back to DB so reloads remember.
  const now = new Date().toISOString();
  getDb().query(
    "UPDATE boards SET dev_command = ?, dev_port = ?, updated_at = ? WHERE id = ?",
  ).run(command, port, now, boardId);

  const res = await forward(`/dev/${boardId}/start`, {
    method: "POST",
    body: JSON.stringify({ command, cwd: board.implementationDir, port }),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

devServerRouter.post("/boards/:boardId/dev/stop", async (c) => {
  const res = await forward(`/dev/${c.req.param("boardId")}/stop`, { method: "POST" });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

devServerRouter.get("/boards/:boardId/dev/logs", async (c) => {
  const limit = c.req.query("limit") ?? "100";
  const res = await forward(`/dev/${c.req.param("boardId")}/logs?limit=${limit}`);
  return new Response(res.body, { status: res.status, headers: res.headers });
});
