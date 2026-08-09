import { Hono } from "hono";
import { manager } from "./manager.ts";

const RUNNER_PORT = Number(process.env["INVENTARIUM_RUNNER_PORT"] ?? process.env["AGENT_TRAIL_RUNNER_PORT"] ?? 3003);

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, role: "runner", ts: new Date().toISOString() }));

// ─── Dev server endpoints ────────────────────────────────────────────────────
// Mirrors the previous /api/boards/:id/dev/* shape but mounted at /dev/:boardId/*
// for clarity. The inventarium server proxies the public routes to here.

app.get("/dev/:boardId/status", async (c) => {
  return c.json(await manager.status(c.req.param("boardId")));
});

app.post("/dev/:boardId/start", async (c) => {
  const body = await c.req.json<{ command: string; cwd: string; port?: number | null }>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const result = manager.start(c.req.param("boardId"), body.command, body.cwd, body.port ?? null);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(await manager.status(c.req.param("boardId")));
});

app.post("/dev/:boardId/stop", async (c) => {
  const r = manager.stop(c.req.param("boardId"));
  return c.json({ ok: r.ok, status: await manager.status(c.req.param("boardId")) });
});

app.get("/dev/:boardId/logs", (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  return c.json(manager.recentLogs(c.req.param("boardId"), Math.max(1, Math.min(500, limit))));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const boot = manager.bootstrap();
console.log(
  `inventarium runner listening on http://localhost:${RUNNER_PORT}` +
  (boot.adopted > 0 ? ` (adopted ${boot.adopted} live process${boot.adopted === 1 ? "" : "es"})` : "") +
  (boot.dropped > 0 ? ` (cleaned up ${boot.dropped} dead entr${boot.dropped === 1 ? "y" : "ies"})` : ""),
);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// We do NOT kill child dev servers on shutdown — that's the whole point of
// running detached. They get re-adopted on the next runner boot.

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    console.log(`[runner] received ${sig}, exiting; dev server children continue running.`);
    process.exit(sig === "SIGINT" ? 130 : 0);
  });
}

export default { port: RUNNER_PORT, fetch: app.fetch };
