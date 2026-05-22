import { Hono } from "hono";
import { cors } from "hono/cors";
import { boardsRouter } from "./routes/boards.ts";
import { tasksRouter } from "./routes/tasks.ts";
import { executionsRouter } from "./routes/executions.ts";
import { decisionsRouter } from "./routes/decisions.ts";
import { artifactsRouter } from "./routes/artifacts.ts";
import { exportRouter } from "./routes/export.ts";
import { getDb } from "./db.ts";

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

// Initialize DB on startup
getDb();

const port = 3002;
console.log(`agent-trail server running on http://localhost:${port}`);

export default { port, fetch: app.fetch };
