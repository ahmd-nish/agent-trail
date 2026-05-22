#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";

const DB_PATH = process.env["AGENT_TRAIL_DB_PATH"];
if (!DB_PATH) {
  process.stderr.write("board-server MCP: missing AGENT_TRAIL_DB_PATH env var\n");
  process.exit(1);
}

const db = new Database(DB_PATH);

const server = new Server(
  { name: "agent-trail-board", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_tasks",
      description: "List tasks on the agent-trail board, optionally filtered by boardId or status.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "Filter by board ID" },
          status: {
            type: "string",
            description: "Filter by status: backlog | ready | in_progress | blocked | in_review | done",
          },
        },
      },
    },
    {
      name: "get_task",
      description: "Get full details for a single task by ID.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
      },
    },
    {
      name: "update_task_status",
      description: "Update a task's status on the board.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: {
            type: "string",
            description: "backlog | ready | in_progress | blocked | in_review | done",
          },
        },
        required: ["taskId", "status"],
      },
    },
    {
      name: "add_task",
      description: "Create a new task on a board.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", description: "low | medium | high | critical" },
          assignee: { type: "string", description: "claude-code | codex | gemini | custom" },
        },
        required: ["boardId", "title"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "list_tasks") {
    const { boardId, status } = (args ?? {}) as { boardId?: string; status?: string };
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: string[] = [];
    if (boardId) { sql += " AND board_id = ?"; params.push(boardId); }
    if (status) { sql += " AND status = ?"; params.push(status); }
    sql += " ORDER BY created_at";
    const rows = db.query(sql).all(...params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }

  if (name === "get_task") {
    const { taskId } = args as { taskId: string };
    const row = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!row) throw new Error(`Task ${taskId} not found`);
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  }

  if (name === "update_task_status") {
    const { taskId, status } = args as { taskId: string; status: string };
    const now = new Date().toISOString();
    const info = db.query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now, taskId);
    if (!info.changes) throw new Error(`Task ${taskId} not found`);
    return { content: [{ type: "text", text: `Task ${taskId} → ${status}` }] };
  }

  if (name === "add_task") {
    const {
      boardId,
      title,
      description = "",
      priority = "medium",
      assignee = "claude-code",
    } = args as { boardId: string; title: string; description?: string; priority?: string; assignee?: string };
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO tasks (id, board_id, title, description, priority, assignee, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, boardId, title, description, priority, assignee, now, now);
    return {
      content: [{ type: "text", text: JSON.stringify({ id, boardId, title, description, priority, assignee }, null, 2) }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
