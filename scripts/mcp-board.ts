#!/usr/bin/env bun
// Thin launcher for the board MCP server. Keeps the DB path resolution in one
// place (packages/core/src/storage/paths.ts) so the DB filename is not
// duplicated across scripts and source.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { resolveDbPath } from "../packages/core/src/storage/paths.ts";

const repoRoot = process.cwd();
const dbPath = resolveDbPath(repoRoot);
const scriptPath = join(repoRoot, "packages/core/src/mcp/board-server.ts");

const proc = spawn("bun", [scriptPath], {
  env: { ...process.env, AGENT_TRAIL_DB_PATH: dbPath },
  stdio: "inherit",
});

proc.on("exit", (code) => process.exit(code ?? 0));
