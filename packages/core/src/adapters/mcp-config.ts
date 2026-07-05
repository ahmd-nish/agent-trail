import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerDef>;
}

export interface AskHumanOpts {
  taskId: string;
  executionId: string;
  dbPath: string;
  scriptPath: string; // absolute path to ask-human.ts
}

export class McpConfigManager {
  constructor(private repoRoot: string) {}

  private readProjectConfig(): McpConfigFile {
    for (const rel of [".mcp.json", ".claude/settings.json"]) {
      const p = join(this.repoRoot, rel);
      if (existsSync(p)) {
        try {
          return JSON.parse(readFileSync(p, "utf-8")) as McpConfigFile;
        } catch {
          // malformed JSON
        }
      }
    }
    return {};
  }

  /**
   * Write a scoped MCP config that always includes ask_human,
   * plus any task-specific MCPs from .mcp.json.
   */
  write(taskId: string, requestedMcps: string[], askHuman: AskHumanOpts): string {
    const allServers = this.readProjectConfig().mcpServers ?? {};
    const scoped: Record<string, McpServerDef> = {};

    // Always include ask_human. Emit both new + legacy env vars for one release
    // so users mid-upgrade with stale spawned MCP processes keep working.
    scoped["agent-trail"] = {
      command: "bun",
      args: [askHuman.scriptPath],
      env: {
        AGENT_TRAIL_DB_PATH: askHuman.dbPath,
        AGENT_TRAIL_TASK_ID: askHuman.taskId,
        AGENT_TRAIL_EXECUTION_ID: askHuman.executionId,
        VIBE_BOARD_DB_PATH: askHuman.dbPath,
        VIBE_BOARD_TASK_ID: askHuman.taskId,
        VIBE_BOARD_EXECUTION_ID: askHuman.executionId,
      },
    };

    // Include task-specific MCPs that exist in the project config
    for (const name of requestedMcps) {
      if (allServers[name]) scoped[name] = allServers[name]!;
    }

    const path = join(tmpdir(), `agent-trail-mcp-${taskId}.json`);
    writeFileSync(path, JSON.stringify({ mcpServers: scoped }, null, 2));
    return path;
  }

  cleanup(taskId: string): void {
    const path = join(tmpdir(), `agent-trail-mcp-${taskId}.json`);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
    }
  }
}
