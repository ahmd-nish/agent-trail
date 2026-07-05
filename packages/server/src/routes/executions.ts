import { Hono } from "hono";
import { executionManager } from "../execution-manager.ts";
import { getDb } from "../db.ts";

export const executionsRouter = new Hono();

// Kick off an execution for a task
executionsRouter.post("/tasks/:taskId/execute", async (c) => {
  const { taskId } = c.req.param();
  const result = await executionManager.start(taskId);
  if ("error" in result) return c.json({ error: result.error }, 409);
  return c.json(result, 201);
});

// PRD_OPEN_SOURCE 2.2 — resume a prior claude session on this task.
// The task's last-recorded claude session_id is used unless the caller
// explicitly overrides via ?sessionId=.
executionsRouter.post("/tasks/:taskId/resume", async (c) => {
  const { taskId } = c.req.param();
  const result = await executionManager.resumeSession(taskId);
  if ("error" in result) return c.json({ error: result.error }, 409);
  return c.json(result, 201);
});

// Stop a running or queued execution
executionsRouter.post("/tasks/:taskId/stop", async (c) => {
  const { taskId } = c.req.param();
  const result = await executionManager.stop(taskId);
  if (!result.ok) return c.json({ error: result.error ?? "Could not stop task" }, 409);
  return c.json({ ok: true });
});

// SSE stream for live task activity
executionsRouter.get("/tasks/:taskId/stream", (c) => {
  const { taskId } = c.req.param();
  const stream = executionManager.subscribe(taskId);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// Telemetry history for a completed execution
executionsRouter.get("/executions/:executionId/telemetry", (c) => {
  const { executionId } = c.req.param();
  const rows = getDb()
    .query("SELECT * FROM telemetry_events WHERE execution_id = ? ORDER BY seq_num ASC")
    .all(executionId);
  return c.json(rows);
});

// List executions for a task
executionsRouter.get("/tasks/:taskId/executions", (c) => {
  const { taskId } = c.req.param();
  const rows = getDb()
    .query("SELECT * FROM executions WHERE task_id = ? ORDER BY started_at DESC")
    .all(taskId);
  return c.json(rows);
});

// PRD_OPEN_SOURCE 2.8 — self-contained replay export.
// Returns the recorded SSE stream as a JSON array; the demo player consumes
// it identically to the bundled demo-fixture.json.
executionsRouter.get("/executions/:executionId/replay", async (c) => {
  const { executionId } = c.req.param();
  const { readReplay } = await import("../testing/replay-recorder.ts");
  const entries = readReplay(executionId);
  if (entries.length === 0) return c.json({ error: "no replay found for this execution" }, 404);
  return c.json({ executionId, events: entries });
});
