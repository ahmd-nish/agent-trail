#!/usr/bin/env bun
/**
 * ask_human MCP server.
 * Spawned per-task via --mcp-config injection.
 * Required env: AGENT_TRAIL_DB_PATH, AGENT_TRAIL_TASK_ID, AGENT_TRAIL_EXECUTION_ID
 *   (or the deprecated VIBE_BOARD_* equivalents for one release)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";
import { readTaskMemory, listTaskMemories } from "../context/memory.ts";

const DB_PATH = process.env["AGENT_TRAIL_DB_PATH"] ?? process.env["VIBE_BOARD_DB_PATH"];
const TASK_ID = process.env["AGENT_TRAIL_TASK_ID"] ?? process.env["VIBE_BOARD_TASK_ID"];
const EXECUTION_ID = process.env["AGENT_TRAIL_EXECUTION_ID"] ?? process.env["VIBE_BOARD_EXECUTION_ID"];
const REPO_ROOT = process.env["AGENT_TRAIL_ROOT"] ?? process.cwd();

if (!DB_PATH || !TASK_ID || !EXECUTION_ID) {
  process.stderr.write(
    "ask-human MCP: missing required env vars AGENT_TRAIL_DB_PATH, AGENT_TRAIL_TASK_ID, AGENT_TRAIL_EXECUTION_ID\n",
  );
  process.exit(1);
}

const db = new Database(DB_PATH);

const server = new Server(
  { name: "agent-trail", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask_human",
      description:
        "Pause execution and ask the human a question. Use this when you need clarification, " +
        "a decision, credentials, or approval before proceeding. " +
        "The human will be notified and can answer via the agent-trail UI. " +
        "After calling this tool you MUST stop all work and output only: AWAITING_HUMAN",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the human. Be specific and actionable.",
          },
          context: {
            type: "string",
            description: "Optional context explaining why you need this information.",
          },
        },
        required: ["question"],
      },
    },
    {
      name: "get_task_memory",
      description:
        "Read the persisted summary of a previously-completed task on this board. " +
        "Useful when your current task references work another task did — you get a " +
        "compact summary (files touched, decisions raised, criteria met) instead of " +
        "having to grep through logs. Returns null when no memory exists yet.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The task id to look up." },
        },
        required: ["taskId"],
      },
    },
    {
      name: "list_task_memories",
      description:
        "List every persisted task memory on this board, newest-first. Returns id + title + " +
        "one-line summary per memory. Use before get_task_memory when you don't know the exact id.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // §4.4 — context orchestrator retrieval tools.
  if (req.params.name === "get_task_memory") {
    const { taskId } = req.params.arguments as { taskId: string };
    const memory = readTaskMemory(REPO_ROOT, taskId);
    return {
      content: [{
        type: "text",
        text: memory === null
          ? `no memory found for task ${taskId} — it may not have completed yet.`
          : JSON.stringify(memory, null, 2),
      }],
    };
  }
  if (req.params.name === "list_task_memories") {
    const memories = listTaskMemories(REPO_ROOT).map((m) => ({
      taskId: m.taskId,
      title: m.taskTitle,
      completedAt: m.completedAt,
      summaryFirstLine: m.summary.split("\n")[0] ?? "",
    }));
    return {
      content: [{
        type: "text",
        text: memories.length === 0
          ? "no task memories on this board yet."
          : JSON.stringify(memories, null, 2),
      }],
    };
  }

  if (req.params.name !== "ask_human") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }

  const { question, context } = req.params.arguments as {
    question: string;
    context?: string;
  };

  const ticketId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.query(
    `INSERT INTO decision_tickets (id, task_id, execution_id, question, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ticketId, TASK_ID, EXECUTION_ID, question, context ?? null, now);

  return {
    content: [
      {
        type: "text",
        text: [
          `PAUSE_EXECUTION:${ticketId}`,
          "",
          `A decision ticket has been created (ID: ${ticketId}).`,
          `Question: ${question}`,
          "",
          "You MUST stop all work now. Do not call any more tools.",
          "Output only the single word: AWAITING_HUMAN",
        ].join("\n"),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
