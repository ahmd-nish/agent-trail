#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";

const DB_PATH = process.env["AGENT_TRAIL_DB_PATH"] ?? process.env["VIBE_BOARD_DB_PATH"];
if (!DB_PATH) {
  process.stderr.write("board-server MCP: missing AGENT_TRAIL_DB_PATH env var\n");
  process.exit(1);
}

const db = new Database(DB_PATH);

const server = new Server(
  { name: "agent-trail", version: "1.0.0" },
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
    // knowledgelayer §4.3 — read-side of the team-context layer. Any teammate's
    // Claude Code session with this MCP configured can query the shared event
    // log. Full hybrid retrieval (BM25 + vector + RRF) lands in Weeks 5-6;
    // for now this is a LIKE-based search which is honest about its limits.
    {
      name: "list_knowledge",
      description: "List active team-knowledge events. Filter by type/scope to scope the pull.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "decision | convention | gotcha | failed_attempt | fix | artifact_summary | steer | handoff" },
          scope: { type: "string", description: "org | project | module:<path> | task:<id>" },
          limit: { type: "number", description: "default 50; hard cap 500" },
        },
      },
    },
    {
      name: "search_knowledge",
      description: "Search team-knowledge events by keyword across subject and body. Returns active events (excludes superseded).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "keyword or phrase" },
          type: { type: "string", description: "optional type filter" },
          limit: { type: "number", description: "default 20; hard cap 200" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_knowledge_event",
      description: "Fetch a single team-knowledge event by ULID.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "the ULID from list_knowledge or search_knowledge" },
        },
        required: ["id"],
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

  if (name === "list_knowledge") {
    const { type, scope, limit: rawLimit } = (args ?? {}) as { type?: string; scope?: string; limit?: number };
    const limit = Math.min(500, Math.max(1, Number(rawLimit ?? 50)));
    const clauses = ["superseded_by IS NULL"];
    const params: string[] = [];
    if (type)  { clauses.push("type = ?");  params.push(type); }
    if (scope) { clauses.push("scope = ?"); params.push(scope); }
    const rows = db.query(
      `SELECT id, actor_kind, actor_name, task_id, execution_id, type, scope, subject, body, paths, confidence, valid_from, created_at
       FROM knowledge_events WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`,
    ).all(...params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }

  if (name === "search_knowledge") {
    const { query, type, limit: rawLimit } = args as { query: string; type?: string; limit?: number };
    if (!query?.trim()) throw new Error("query is required");
    const limit = Math.min(200, Math.max(1, Number(rawLimit ?? 20)));
    // LIKE with `%` around the pattern — deliberate: proper BM25 + vector
    // retrieval waits for Weeks 5-6, and pretending we have it before we do
    // is exactly what the doc warns against. Escape backslash + LIKE wildcards.
    const escaped = query.trim().replace(/[\\%_]/g, (m) => `\\${m}`);
    const like = `%${escaped}%`;
    const clauses = ["superseded_by IS NULL", "(subject LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')"];
    const params: string[] = [like, like];
    if (type) { clauses.push("type = ?"); params.push(type); }
    const rows = db.query(
      `SELECT id, actor_kind, actor_name, task_id, type, scope, subject, body, paths, confidence, valid_from
       FROM knowledge_events WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`,
    ).all(...params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }

  if (name === "get_knowledge_event") {
    const { id } = args as { id: string };
    if (!id) throw new Error("id is required");
    const row = db.query("SELECT * FROM knowledge_events WHERE id = ?").get(id);
    if (!row) throw new Error(`knowledge event ${id} not found`);
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
