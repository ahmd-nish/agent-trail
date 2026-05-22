#!/usr/bin/env bun
/**
 * ask_human MCP server.
 * Spawned per-task via --mcp-config injection.
 * Required env: AGENT_TRAIL_DB_PATH, AGENT_TRAIL_TASK_ID, AGENT_TRAIL_EXECUTION_ID
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";

const DB_PATH = process.env["AGENT_TRAIL_DB_PATH"];
const TASK_ID = process.env["AGENT_TRAIL_TASK_ID"];
const EXECUTION_ID = process.env["AGENT_TRAIL_EXECUTION_ID"];

if (!DB_PATH || !TASK_ID || !EXECUTION_ID) {
  process.stderr.write(
    "ask-human MCP: missing required env vars AGENT_TRAIL_DB_PATH, AGENT_TRAIL_TASK_ID, AGENT_TRAIL_EXECUTION_ID\n",
  );
  process.exit(1);
}

const db = new Database(DB_PATH);

const server = new Server(
  { name: "agent-trail", version: "0.1.0" },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
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
