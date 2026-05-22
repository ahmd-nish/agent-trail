#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { join } from "node:path";

const BASE_URL = process.env["AGENT_TRAIL_URL"] ?? "http://localhost:3002";
const REPO_ROOT = join(import.meta.dir, "../../..");

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case "init":
    await cmdInit();
    break;
  case "start":
    await cmdStart(rest[0]);
    break;
  case "status":
    await cmdStatus();
    break;
  default:
    printHelp();
    process.exit(cmd ? 1 : 0);
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdInit() {
  checkPrerequisites();

  const alreadyUp = await ping();
  if (alreadyUp) {
    console.log(`${c.green("✓")} Server already running at ${BASE_URL}`);
    openBrowser("http://localhost:5173");
    return;
  }

  console.log(`${c.dim("Starting agent-trail…")}`);

  const server = spawn(
    process.execPath,
    [join(REPO_ROOT, "packages/server/src/index.ts")],
    { stdio: "inherit", cwd: REPO_ROOT },
  );

  server.on("error", (err) => {
    console.error(`${c.red("✗")} Failed to start server: ${err.message}`);
    process.exit(1);
  });

  server.on("exit", (code) => process.exit(code ?? 0));

  // Wait for server to accept connections
  const up = await waitForServer(BASE_URL);
  if (!up) {
    console.error(`${c.red("✗")} Server didn't start in time`);
    process.exit(1);
  }

  console.log(`${c.green("✓")} Server running at ${c.bold(BASE_URL)}`);
  console.log(`${c.dim("  Web UI:")} bun run dev:web → http://localhost:5173`);
  console.log(`${c.dim("  API:  ")} ${BASE_URL}/api/health`);

  openBrowser("http://localhost:5173");
}

async function cmdStart(taskId: string | undefined) {
  if (!taskId) {
    console.error(`Usage: agent-trail start ${c.bold("<taskId>")}`);
    process.exit(1);
  }

  // Kick off execution
  let res = await apiFetch(`/api/tasks/${taskId}/execute`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text();
    console.error(`${c.red("✗")} ${body}`);
    process.exit(1);
  }
  const { executionId } = (await res.json()) as { executionId: string };
  console.log(`${c.green("▶")} Execution ${c.dim(executionId.slice(0, 8))} started`);

  // Stream events
  res = await apiFetch(`/api/tasks/${taskId}/stream`);
  if (!res.body) { console.error("No stream body"); process.exit(1); }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let exitCode = 0;
  let done = false;

  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
        printStreamEvent(ev);
        if (ev["type"] === "execution_complete" || ev["type"] === "awaiting_human") {
          if (ev["type"] === "awaiting_human") {
            console.log(`\n${c.amber("⏸")} Awaiting human decision — check the board at http://localhost:5173`);
            exitCode = 1;
          } else if (ev["status"] !== "completed") {
            exitCode = 1;
          }
          done = true;
        }
      } catch { /* non-JSON */ }
    }
  }
  process.exit(exitCode);
}

async function cmdStatus() {
  let boards: Array<{ id: string; name: string }>;
  try {
    const res = await apiFetch("/api/boards");
    boards = await res.json();
  } catch {
    console.error(`${c.red("✗")} Cannot reach server at ${BASE_URL} — run ${c.bold("agent-trail init")} first`);
    process.exit(1);
  }

  if (boards.length === 0) {
    console.log(`No boards yet. Open ${c.bold("http://localhost:5173")} to create one.`);
    return;
  }

  for (const board of boards) {
    const res = await apiFetch(`/api/boards/${board.id}/tasks`);
    const tasks = (await res.json()) as Array<{
      id: string;
      title: string;
      status: string;
      priority: string;
      assignee: string;
    }>;

    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

    console.log(`\n${c.bold(board.name)} ${c.dim(`(${board.id.slice(0, 8)})`)}`);
    const order = ["backlog", "ready", "in_progress", "blocked", "in_review", "done"];
    for (const s of order) {
      if (counts[s]) console.log(`  ${statusIcon(s)} ${s.padEnd(12)} ${counts[s]}`);
    }

    for (const t of tasks) {
      const icon = statusIcon(t.status);
      const pri = priorityColor(t.priority);
      console.log(`  ${icon} ${pri} ${t.title} ${c.dim(t.id.slice(0, 8))}`);
    }
  }
  console.log("");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${c.bold("agent-trail")} — AI-native kanban board for Claude Code

${c.dim("Usage:")} agent-trail <command>

${c.dim("Commands:")}
  ${c.bold("init")}              Start the API server and open the board
  ${c.bold("start")} <taskId>   Execute a task and stream live events
  ${c.bold("status")}           Show all boards and task counts
`);
}

function checkPrerequisites() {
  if (!Bun.which("claude")) {
    console.error(`${c.red("✗")} claude CLI not found in PATH`);
    console.error(`  Install from https://claude.ai/download`);
    process.exit(1);
  }
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.warn(`${c.amber("⚠")}  ANTHROPIC_API_KEY not set — planner will fail`);
  }
}

async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch { return false; }
}

async function waitForServer(url: string, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await ping()) return true;
  }
  return false;
}

function apiFetch(path: string, init?: RequestInit) {
  return fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function openBrowser(url: string) {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

function printStreamEvent(ev: Record<string, unknown>) {
  if (ev["type"] === "connected") {
    console.log(`${c.dim("  ~")} connected`);
  } else if (ev["type"] === "tool_call") {
    console.log(`  ${c.purple("→")} ${ev["tool"]}`);
  } else if (ev["type"] === "tool_result") {
    console.log(`  ${ev["isError"] ? c.red("← error") : c.dim("← ok")}`);
  } else if (ev["type"] === "text") {
    const text = String(ev["text"] ?? "").slice(0, 100);
    console.log(`  ${c.dim(text)}`);
  } else if (ev["type"] === "test_result") {
    const icon = ev["passed"] ? c.green("✓") : c.red("✗");
    console.log(`  ${icon} tests ${ev["passed"] ? "passed" : "failed"} (exit ${ev["exitCode"]})`);
  } else if (ev["type"] === "execution_complete") {
    const icon = ev["status"] === "completed" ? c.green("✓") : c.red("✗");
    console.log(`\n${icon} ${ev["status"]}`);
  }
}

function statusIcon(status: string): string {
  const map: Record<string, string> = {
    backlog: c.dim("○"),
    ready: c.blue("○"),
    in_progress: c.green("●"),
    blocked: c.amber("!"),
    in_review: c.purple("◐"),
    done: c.green("✓"),
  };
  return map[status] ?? "?";
}

function priorityColor(p: string): string {
  const map: Record<string, (s: string) => string> = {
    critical: c.red,
    high: c.amber,
    medium: c.blue,
    low: c.dim,
  };
  return (map[p] ?? c.dim)(`[${p}]`);
}

// ─── Minimal ANSI helpers ────────────────────────────────────────────────────

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  purple: (s: string) => `\x1b[35m${s}\x1b[0m`,
};
