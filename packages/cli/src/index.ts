#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { addNote, contextDir, ensureContextDir } from "../../core/src/context/store.ts";
import { exportToFile, hydrateFromFile, readStateFile, statePath } from "../../core/src/context/sync.ts";
import { resolveDbPath, resolveProjectRoot } from "../../core/src/storage/paths.ts";

const DEFAULT_PORT = Number(process.env["AGENT_TRAIL_PORT"] ?? process.env["PORT"] ?? 3002);
const BASE_URL_FROM_ENV = process.env["AGENT_TRAIL_URL"] ?? process.env["VIBE_BOARD_URL"];
let BASE_URL = BASE_URL_FROM_ENV ?? `http://localhost:${DEFAULT_PORT}`;

// The CLI ships alongside the server package. In the published npm layout the
// server lives at ../../server; in the workspace it lives at ../../server too.
// Fall back to a monorepo path for `bun run cli` from repo root.
const SERVER_CANDIDATES = [
  join(import.meta.dir, "../../server/src/index.ts"),
  join(import.meta.dir, "../../../server/src/index.ts"),
];
const SERVER_ENTRY = SERVER_CANDIDATES.find((p) => existsSync(p));

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

const [, , rawCmd, ...rest] = process.argv;
// No subcommand OR a flag as first arg → default to `init` (launch flow).
// This is what `npx agent-trail` and `npx agent-trail --demo` land in.
const cmd = !rawCmd || rawCmd.startsWith("--") ? "init" : rawCmd;
const initArgs = !rawCmd || rawCmd.startsWith("--") ? [rawCmd, ...rest].filter(Boolean) as string[] : rest;

if (initArgs.includes("--help") || initArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}

switch (cmd) {
  case "init":
    await cmdInit(initArgs);
    break;
  case "plan":
    await cmdPlan(rest);
    break;
  case "start":
    await cmdStart(rest[0]);
    break;
  case "status":
    await cmdStatus();
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "run":
    await cmdRun(rest);
    break;
  case "resume":
    await cmdResume(rest[0]);
    break;
  case "context":
    await cmdContext(rest);
    break;
  case "sync":
    await cmdSync(rest);
    break;
  case "loop":
    await cmdLoop(rest);
    break;
  case "library":
    await cmdLibrary(rest);
    break;
  case "deploy":
    await cmdDeploy(rest);
    break;
  case "knowledge":
    await cmdKnowledge(rest);
    break;
  case "workspace":
    await cmdWorkspace(rest);
    break;
  default:
    printHelp();
    process.exit(rawCmd ? 1 : 0);
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdInit(args: string[]) {
  const demoMode = args.includes("--demo");
  const noOpen = args.includes("--no-open");
  const portFlag = flagValue(args, "--port");
  const requestedPort = portFlag ? Number(portFlag) : (BASE_URL_FROM_ENV ? undefined : DEFAULT_PORT);

  if (!SERVER_ENTRY) {
    console.error(`${c.red("✗")} Server package not found next to the CLI. Is agent-trail installed correctly?`);
    process.exit(1);
  }

  // If BASE_URL_FROM_ENV is set, just try to hit that — otherwise pick a port.
  let port = requestedPort ?? DEFAULT_PORT;
  const alreadyUp = await ping();
  if (alreadyUp) {
    console.log(`${c.green("✓")} agent-trail already running at ${c.bold(BASE_URL)}`);
    if (!noOpen) openBrowser(BASE_URL + (demoMode ? "/?demo=1" : ""));
    return;
  }

  if (!BASE_URL_FROM_ENV) {
    port = await findOpenPort(port);
    BASE_URL = `http://localhost:${port}`;
  }

  checkPrerequisites({ warnOnly: demoMode });

  console.log(`${c.dim("Starting agent-trail…")} ${c.dim(`(port ${port})`)}`);

  // Prefer bun (native SQLite bindings). Fall back to node if bun isn't in PATH
  // — the caller will see a clear error rather than a silent failure.
  const runtime = Bun.which("bun") ?? process.execPath;
  const server = spawn(
    runtime,
    [SERVER_ENTRY],
    {
      stdio: "inherit",
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_TRAIL_PORT: String(port),
        // Server default already uses CWD; pass explicit for clarity.
        AGENT_TRAIL_ROOT: process.env["AGENT_TRAIL_ROOT"] ?? process.cwd(),
      },
    },
  );

  const shutdown = () => { try { server.kill("SIGTERM"); } catch { /* already dead */ } };
  process.on("SIGINT", () => { shutdown(); process.exit(130); });
  process.on("SIGTERM", () => { shutdown(); process.exit(143); });

  server.on("error", (err) => {
    console.error(`${c.red("✗")} Failed to start server: ${err.message}`);
    process.exit(1);
  });

  server.on("exit", (code) => process.exit(code ?? 0));

  const up = await waitForServer(BASE_URL);
  if (!up) {
    console.error(`${c.red("✗")} Server didn't start in time`);
    process.exit(1);
  }

  const openUrl = BASE_URL + (demoMode ? "/?demo=1" : "");
  console.log(`${c.green("✓")} agent-trail running at ${c.bold(openUrl)}`);
  console.log(`${c.dim("  press Ctrl-C to stop")}`);

  if (!noOpen) openBrowser(openUrl);
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

async function cmdPlan(args: string[]) {
  // agent-trail plan <file> [--name <board>] [--dry-run] [--board <id>]
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error(`Usage: agent-trail plan ${c.bold("<prd-file>")} [--name <board-name>] [--board <id>] [--dry-run]`);
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const nameIdx = args.indexOf("--name");
  const boardIdx = args.indexOf("--board");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
  const boardId = boardIdx >= 0 ? args[boardIdx + 1] : undefined;

  if (!dryRun && !name && !boardId) {
    console.error(`Provide ${c.bold("--name <board-name>")} to create a new board or ${c.bold("--board <id>")} to add to an existing one`);
    process.exit(1);
  }

  let prdText: string;
  try {
    prdText = await Bun.file(file).text();
  } catch {
    console.error(`${c.red("✗")} Cannot read file: ${file}`);
    process.exit(1);
  }

  console.log(`${c.dim("Planning")} ${c.bold(file)}…`);

  let res: Response;
  try {
    res = await apiFetch("/api/boards/plan", {
      method: "POST",
      body: JSON.stringify({ prdText, name, boardId, dryRun }),
    });
  } catch {
    console.error(`${c.red("✗")} Cannot reach server at ${BASE_URL} — run ${c.bold("agent-trail init")} first`);
    process.exit(1);
  }

  if (!res.ok) {
    const err = await res.text();
    console.error(`${c.red("✗")} Planner error: ${err}`);
    process.exit(1);
  }

  const result = (await res.json()) as {
    board: { id: string; name: string } | null;
    tasks: Array<{ id: string; title: string; priority: string; dependsOn: string[]; tddEnabled: boolean }>;
    usage: { inputTokens: number; outputTokens: number };
    dryRun: boolean;
  };

  if (result.board) {
    console.log(`\n${c.green("✓")} Board: ${c.bold(result.board.name)} ${c.dim(`(${result.board.id.slice(0, 8)})`)}`);
  } else {
    console.log(`\n${c.amber("~")} Dry run — tasks not saved`);
  }

  console.log(`\n${c.dim("Task graph")} (${result.tasks.length} tasks):\n`);

  for (const t of result.tasks) {
    const deps = t.dependsOn.length > 0
      ? c.dim(` → depends on: ${t.dependsOn.join(", ")}`)
      : "";
    const tdd = t.tddEnabled ? c.green(" TDD") : "";
    console.log(`  ${priorityColor(t.priority)} ${c.bold(t.title)}${tdd}${deps}`);
    console.log(`    ${c.dim(t.id)}`);
  }

  console.log(`\n${c.dim(`Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`)}`);

  if (!result.dryRun && result.board) {
    console.log(`\n${c.dim("Open the board:")} ${BASE_URL}`);
  }
}

async function cmdDoctor() {
  console.log(`${c.bold("agent-trail doctor")} ${c.dim("— preflight checks\n")}`);
  const checks: Array<{ name: string; ok: boolean; fix?: string; note?: string }> = [];

  // 1. Bun runtime
  const bun = Bun.which("bun");
  checks.push({
    name: "bun runtime",
    ok: !!bun,
    fix: bun ? undefined : "Install Bun ≥ 1.1: curl -fsSL https://bun.sh/install | bash",
    note: bun ? Bun.version : undefined,
  });

  // 2. git
  const git = Bun.which("git");
  checks.push({
    name: "git",
    ok: !!git,
    fix: git ? undefined : "Install git — https://git-scm.com/downloads",
  });

  // 3. claude CLI
  const claude = Bun.which("claude");
  checks.push({
    name: "claude CLI",
    ok: !!claude,
    fix: claude ? undefined : `Install from https://claude.ai/download, then run ${c.bold("claude login")}`,
  });

  // 4. ANTHROPIC_API_KEY (only warn — claude CLI may hold its own auth)
  const key = process.env["ANTHROPIC_API_KEY"];
  checks.push({
    name: "ANTHROPIC_API_KEY",
    ok: !!key,
    fix: key ? undefined : "Optional: export ANTHROPIC_API_KEY=... (needed only when not logged in via claude CLI)",
    note: key ? `set (${key.length} chars)` : undefined,
  });

  // 5. Port availability
  const portOpen = await isPortOpen(DEFAULT_PORT);
  checks.push({
    name: `port ${DEFAULT_PORT} available`,
    ok: portOpen,
    fix: portOpen ? undefined : `Something is listening on ${DEFAULT_PORT}. The CLI will auto-pick the next open port.`,
  });

  // 6. CWD is writable (creates DB, worktrees, .mcp.json here)
  let cwdWritable = false;
  try {
    const probe = join(process.cwd(), ".agent-trail-doctor-probe");
    await Bun.write(probe, "ok");
    await Bun.file(probe).exists();
    // best-effort cleanup
    try { await Bun.$`rm ${probe}`.quiet(); } catch { /* ignore */ }
    cwdWritable = true;
  } catch { cwdWritable = false; }
  checks.push({
    name: "cwd writable",
    ok: cwdWritable,
    fix: cwdWritable ? undefined : `Run agent-trail from a directory you can write to (current: ${process.cwd()})`,
  });

  // Render
  let hasFail = false;
  for (const chk of checks) {
    const icon = chk.ok ? c.green("✓") : (chk.name.startsWith("ANTHROPIC") ? c.amber("~") : c.red("✗"));
    const note = chk.note ? c.dim(` (${chk.note})`) : "";
    console.log(`  ${icon} ${chk.name}${note}`);
    if (!chk.ok && chk.fix) console.log(`      ${c.dim(chk.fix)}`);
    if (!chk.ok && !chk.name.startsWith("ANTHROPIC")) hasFail = true;
  }

  console.log("");
  if (hasFail) {
    console.log(`${c.red("✗")} One or more checks failed — fix them, then rerun ${c.bold("agent-trail doctor")}.`);
    process.exit(1);
  }
  console.log(`${c.green("✓")} Ready to run ${c.bold("agent-trail")}`);
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

${c.dim("Usage:")} agent-trail ${c.dim("[command] [flags]")}

${c.dim("With no command, launches the server + opens the board.")}

${c.dim("Commands:")}
  ${c.bold("init")}                            Start the API server and open the board (default)
  ${c.bold("plan")} <file> --name <board>      Generate a task graph from a PRD file
  ${c.bold("start")} <taskId>                  Execute a task and stream live events
  ${c.bold("run")}   --task <id> [--ci]        Headless run — poll for terminal state, print markdown summary
  ${c.bold("resume")} <taskId>                 Resume the task's previous claude session
  ${c.bold("context")} add "<text>"            Append a team ruling to .agent-trail/context/notes.md
  ${c.bold("context")} ls                      List markdown files in the team context store
  ${c.bold("sync")} export|import|status       Export/import the board+task graph to .agent-trail/state.json
  ${c.bold("loop")} --board <id> [--budget $N] Run the whole board DAG until done / budget / decision ticket
  ${c.bold("library")} add|new|ls|rm            Manage the team agent library (.agent-trail/library/agents/)
  ${c.bold("deploy")} --board <id> --target <n> Deploy a board via a configured target (human-gated by default)
  ${c.bold("knowledge")} backfill|ls|fold      Shared team knowledge log (docs/knowledgelayer.md)
  ${c.bold("workspace")} create|member|token   Relay identity: workspaces, members, API tokens
  ${c.bold("status")}                          Show all boards and task counts
  ${c.bold("doctor")}                          Preflight checks (claude, git, ports, API key)

${c.dim("init flags:")}
  --demo                 Open with demo replay mode
  --no-open              Don't launch a browser
  --port <n>             Force a specific port (default 3002, auto-fallback if busy)

${c.dim("plan flags:")}
  --name <board-name>    Create a new board with this name
  --board <id>           Add tasks to an existing board
  --dry-run              Print the task graph without saving
`);
}

function checkPrerequisites(opts: { warnOnly?: boolean } = {}) {
  if (!Bun.which("claude")) {
    const msg = `${c.red("✗")} claude CLI not found in PATH`;
    const fix = `  Install from https://claude.ai/download, then run ${c.bold("claude login")}`;
    if (opts.warnOnly) {
      console.warn(msg);
      console.warn(fix);
      console.warn(`  ${c.dim("Demo mode will work without it — real executions won't.")}`);
      return;
    }
    console.error(msg);
    console.error(fix);
    process.exit(1);
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next;
}

async function findOpenPort(preferred: number, maxTries = 20): Promise<number> {
  for (let p = preferred; p < preferred + maxTries; p++) {
    if (await isPortOpen(p)) return p;
  }
  throw new Error(`No open port found in range ${preferred}-${preferred + maxTries}`);
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
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

// PRD_OPEN_SOURCE 2.7 — headless CI mode.
// Usage: agent-trail run --task <id> --ci [--timeout 900]
//   • Kicks off the task's execution
//   • Polls /api/tasks/:boardId/tasks (via the task-belongs-to-board lookup)
//     until the task lands terminal (`in_review`, `done`, `blocked`, `failed`)
//   • Exits 0 on in_review/done, 1 on blocked/failed
//   • Prints a markdown summary to stdout — pipe into $GITHUB_STEP_SUMMARY.
async function cmdRun(args: string[]) {
  const taskFlag = flagValue(args, "--task");
  const timeoutSec = Number(flagValue(args, "--timeout") ?? 1800);
  const ci = args.includes("--ci");
  if (!taskFlag) {
    console.error(`Usage: agent-trail run --task ${c.bold("<taskId>")} [--ci] [--timeout <seconds>]`);
    process.exit(2);
  }

  // Kick off.
  const kick = await apiFetch(`/api/tasks/${taskFlag}/execute`, { method: "POST" });
  if (kick.status === 409 || !kick.ok) {
    const body = await kick.text().catch(() => "");
    console.error(`${c.red("✗")} could not start task: ${body}`);
    process.exit(1);
  }
  const { executionId } = await kick.json() as { executionId: string };
  if (!ci) console.log(`${c.dim("▶")} started execution ${executionId.slice(0, 8)}`);

  // Poll executions endpoint for terminal status.
  const deadline = Date.now() + timeoutSec * 1000;
  let terminal: { status: string; error_message: string | null; total_input_tokens: number | null; total_output_tokens: number | null; duration_ms: number | null } | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await apiFetch(`/api/tasks/${taskFlag}/executions`);
    if (!res.ok) continue;
    const rows = await res.json() as Array<{ id: string; status: string; error_message: string | null; total_input_tokens: number | null; total_output_tokens: number | null; duration_ms: number | null }>;
    const row = rows.find((r) => r.id === executionId);
    if (row && (row.status === "completed" || row.status === "failed" || row.status === "awaiting_human")) {
      terminal = row;
      break;
    }
  }

  if (!terminal) {
    console.error(`${c.red("✗")} timed out after ${timeoutSec}s`);
    process.exit(124);
  }

  const passed = terminal.status === "completed";
  const summary = [
    `## agent-trail — task ${taskFlag.slice(0, 8)}`,
    "",
    `- **Result:** ${passed ? "✅ completed" : terminal.status === "awaiting_human" ? "⏸ awaiting_human" : "❌ failed"}`,
    `- Duration: ${(terminal.duration_ms ?? 0) / 1000}s`,
    `- Tokens in: ${terminal.total_input_tokens ?? 0}`,
    `- Tokens out: ${terminal.total_output_tokens ?? 0}`,
    terminal.error_message ? `- Error: \`${terminal.error_message}\`` : "",
    "",
    `Execution id: \`${executionId}\``,
  ].filter(Boolean).join("\n");

  console.log(summary);
  process.exit(passed ? 0 : (terminal.status === "awaiting_human" ? 2 : 1));
}

// PRD_OPEN_SOURCE 3.2 — team-context store CLI.
//   agent-trail context add "<text>" [--file conventions]
//   agent-trail context ls
// Writes land under <project root>/.agent-trail/context/ so every future
// execution picks them up via the L0 constitution loader (§3.4).
async function cmdContext(args: string[]) {
  const sub = args[0];
  if (sub === "add") {
    const positional: string[] = [];
    let file: string | undefined;
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--file") { file = args[++i]; continue; }
      positional.push(a);
    }
    const text = positional.join(" ").trim();
    if (!text) {
      console.error(`Usage: agent-trail context add ${c.bold(`"<text>"`)} [--file <name>]`);
      process.exit(2);
    }
    const root = process.env["AGENT_TRAIL_ROOT"] ?? resolveProjectRoot();
    const path = addNote(root, { text, file });
    console.log(`${c.green("✓")} appended to ${c.bold(path)}`);
    return;
  }
  if (sub === "ls" || sub === "list") {
    const root = process.env["AGENT_TRAIL_ROOT"] ?? resolveProjectRoot();
    const dir = contextDir(root);
    ensureContextDir(root);
    const files = readdirSync(dir).filter((f) => /\.mdx?$/i.test(f)).sort();
    if (files.length === 0) {
      console.log(`${c.dim("(empty)")}  ${c.dim(dir)}`);
      console.log(`  Add your first ruling: ${c.bold(`agent-trail context add "..."`)}`);
      return;
    }
    console.log(`${c.dim(dir)}`);
    for (const f of files) {
      const full = join(dir, f);
      const size = statSync(full).size;
      const firstLine = readFileSync(full, "utf8").split("\n").find((l) => l.trim()) ?? "";
      console.log(`  ${c.bold(f)}  ${c.dim(`(${size}B)`)}  ${c.dim(firstLine.slice(0, 60))}`);
    }
    return;
  }
  console.error(`Usage: agent-trail context ${c.bold("add|ls")} [args]`);
  process.exit(2);
}

// PRD_OPEN_SOURCE §5.6 — deploy agent CLI.
//   agent-trail deploy --board <id> --target <name> [--auto-confirm] [--yes] [--timeout 900]
// Default: raise a decision ticket, print the deploy id, and poll until the
// deploy status leaves 'pending' (i.e. the user confirmed elsewhere). --yes
// answers the ticket immediately from the CLI. --auto-confirm skips the
// ticket entirely (CI mode; trusted paths only).
async function cmdDeploy(args: string[]) {
  const boardId = flagValue(args, "--board");
  const target  = flagValue(args, "--target");
  const timeoutSec = Number(flagValue(args, "--timeout") ?? 900);
  const autoConfirm = args.includes("--auto-confirm");
  const yes = args.includes("--yes") || autoConfirm;
  if (!boardId || !target) {
    console.error(`Usage: agent-trail deploy --board ${c.bold("<id>")} --target ${c.bold("<name>")} [--auto-confirm] [--yes]`);
    process.exit(2);
  }

  const kick = await apiFetch(`/api/boards/${boardId}/deploy`, {
    method: "POST",
    body: JSON.stringify({ targetName: target, autoConfirm }),
  });
  if (!kick.ok) {
    const err = await kick.text().catch(() => "");
    console.error(`${c.red("✗")} kick failed: ${err}`);
    process.exit(1);
  }
  const { deployId, ticketId, status: initStatus } = await kick.json() as {
    deployId: string; ticketId?: string; status: string; requiresConfirmation: boolean;
  };
  console.log(`${c.dim("▶")} deploy ${c.dim(deployId.slice(0, 12))} — ${initStatus}`);
  if (ticketId && !yes) {
    console.log(`${c.amber("⏸")} awaiting human confirmation (ticket ${ticketId.slice(0, 8)}) — approve in the UI or rerun with --yes`);
  }

  if (yes && ticketId) {
    // Auto-approve the ticket by hitting the confirm endpoint directly.
    const conf = await apiFetch(`/api/deploys/${deployId}/confirm`, { method: "POST" });
    if (!conf.ok) {
      const err = await conf.text().catch(() => "");
      console.error(`${c.red("✗")} confirm failed: ${err}`);
      process.exit(1);
    }
  }

  // Poll for terminal state.
  const deadline = Date.now() + timeoutSec * 1000;
  const terminal = new Set(["success", "healthcheck_failed", "command_failed", "rolled_back", "timed_out"]);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = await apiFetch(`/api/deploys/${deployId}`);
    if (!cur.ok) continue;
    const row = await cur.json() as { status: string; command_output?: string; healthcheck_status?: string | null; rollback_output?: string | null };
    if (terminal.has(row.status)) {
      const icon = row.status === "success" ? c.green("✓") : c.red("✗");
      console.log(`${icon} deploy ${row.status}`);
      if (row.healthcheck_status) console.log(`  ${c.dim("healthcheck:")} ${row.healthcheck_status}`);
      if (row.command_output)     console.log(`  ${c.dim("output:")} ${row.command_output.split("\n").slice(-4).join("\n  ")}`);
      if (row.rollback_output)    console.log(`  ${c.dim("rollback:")} ${row.rollback_output.split("\n").slice(-4).join("\n  ")}`);
      process.exit(row.status === "success" ? 0 : 1);
    }
  }
  console.error(`${c.red("✗")} timed out after ${timeoutSec}s`);
  process.exit(124);
}

// knowledgelayer.md §4.1–§4.2 — knowledge event log CLI.
//   agent-trail knowledge backfill    Sweep existing .agent-trail/context/*.md into events
//   agent-trail knowledge ls [--type <t>] [--limit <n>]   List active events
//   agent-trail knowledge fold [--cap <chars>]            Preview the constitution projection
async function cmdKnowledge(args: string[]) {
  const sub = args[0];
  const { Database } = await import("bun:sqlite");
  const {
    append: _append, list, foldConstitution, backfillFromContextDir,
    exportEventsToJsonl, importEventsFromJsonl,
    projectAgentsMd, projectConstitutionMd,
    KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES,
    KNOWLEDGE_EVENTS_FTS, KNOWLEDGE_EVENTS_FTS_TRIGGERS,
  } = await import("../../core/src/knowledge/index.ts");
  void _append; // reserved for future `knowledge add` subcommand
  const root = resolveProjectRoot();
  const db = new Database(resolveDbPath(root));
  // Fresh installs pre-migration might not have the table yet — apply the DDL
  // idempotently so `bunx @agent-trail/cli knowledge …` works before the
  // server has ever started.
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) db.exec(s);
  db.exec(KNOWLEDGE_EVENTS_FTS);
  for (const s of KNOWLEDGE_EVENTS_FTS_TRIGGERS) db.exec(s);

  const fs = await import("node:fs");
  const path = await import("node:path");

  try {
    switch (sub) {
      case "backfill": {
        const rpt = backfillFromContextDir(db, root);
        console.log(`${c.bold("Backfill from")} ${c.dim(root + "/.agent-trail/context/")}`);
        for (const f of rpt.filesRead) console.log(`  ${c.dim("read")} ${f}`);
        console.log(`  ${c.green("+")} ${rpt.decisionsInserted} decisions · ${c.dim(String(rpt.decisionsSkipped) + " already present")}`);
        console.log(`  ${c.green("+")} ${rpt.notesInserted} conventions · ${c.dim(String(rpt.notesSkipped) + " already present")}`);
        return;
      }
      case "ls": {
        const typeArg = flagValue(args, "--type");
        const limit = Number(flagValue(args, "--limit") ?? 50);
        const events = list(db, { type: typeArg as ReturnType<typeof list>[number]["type"] | undefined, limit });
        if (events.length === 0) { console.log(c.dim("(no events)")); return; }
        for (const ev of events) {
          const t = ev.validFrom.slice(0, 10);
          console.log(`${c.dim(t)} ${c.bold(ev.type.padEnd(18))} ${c.dim(ev.actorName)}  ${ev.subject}`);
        }
        return;
      }
      case "fold": {
        const cap = Number(flagValue(args, "--cap") ?? 8000);
        const folded = foldConstitution(db, { charCap: cap });
        if (!folded.markdown) { console.log(c.dim("(no active events — try `knowledge backfill` first)")); return; }
        console.log(folded.markdown);
        console.log("");
        console.log(c.dim(`— ${folded.totalChars} chars${folded.truncated ? " (truncated)" : ""} across ${folded.sections.length} section(s)`));
        return;
      }
      case "export": {
        const outDir = flagValue(args, "--dir") ?? path.join(root, ".agent-trail", "export");
        const includeSuperseded = args.includes("--include-superseded");
        fs.mkdirSync(outDir, { recursive: true });
        const jsonl = exportEventsToJsonl(db, { includeSuperseded });
        fs.writeFileSync(path.join(outDir, "events.jsonl"), jsonl, "utf8");
        fs.writeFileSync(path.join(outDir, "AGENTS.md"), projectAgentsMd(db), "utf8");
        fs.writeFileSync(path.join(outDir, "constitution.md"), projectConstitutionMd(db), "utf8");
        const n = jsonl ? jsonl.trim().split("\n").length : 0;
        console.log(`${c.green("✓")} exported ${n} event(s) to ${c.dim(outDir)}`);
        console.log(`  ${c.dim("events.jsonl")}    ${n} rows`);
        console.log(`  ${c.dim("AGENTS.md")}       standardized team-guidance file`);
        console.log(`  ${c.dim("constitution.md")} full constitution projection`);
        return;
      }
      case "import": {
        const file = args[1] ?? flagValue(args, "--file");
        if (!file) { console.error(`${c.red("✗")} usage: agent-trail knowledge import <events.jsonl>`); process.exit(2); }
        const jsonl = fs.readFileSync(file, "utf8");
        const rpt = importEventsFromJsonl(db, jsonl);
        console.log(`${c.green("+")} imported ${rpt.inserted} event(s) · ${c.dim(String(rpt.skipped) + " already present or malformed")}`);
        return;
      }
      case "bench": {
        const { runBench } = await import("../../core/src/knowledge/bench.ts");
        const daysStr = flagValue(args, "--days");
        const since = daysStr ? new Date(Date.now() - Number(daysStr) * 86400_000).toISOString() : undefined;
        const rpt = runBench(db, since ? { since } : undefined);
        const emitJson = args.includes("--json");
        if (emitJson) { console.log(JSON.stringify(rpt, null, 2)); return; }
        console.log(`${c.bold("agent-trail bench")}  ${c.dim(rpt.windowStart.slice(0, 10) + " → " + rpt.windowEnd.slice(0, 10))}`);
        console.log("");
        console.log(`${c.bold("Tasks")}         ${rpt.tasks.total} total · ${c.green(String(rpt.tasks.completed) + " completed")} · ${c.red(String(rpt.tasks.failed) + " failed/blocked")} · ${c.dim("completion " + (rpt.tasks.completionRate * 100).toFixed(1) + "%")}`);
        console.log(`${c.bold("Tokens")}        ${(rpt.tokens.totalInput / 1000).toFixed(1)}K in / ${(rpt.tokens.totalOutput / 1000).toFixed(1)}K out · avg ${Math.round(rpt.tokens.avgInputPerExecution)} + ${Math.round(rpt.tokens.avgOutputPerExecution)} per execution`);
        const dur = rpt.timing.avgDurationMs;
        console.log(`${c.bold("Timing")}        avg execution ${(dur / 1000).toFixed(1)}s${rpt.timing.avgTimeToFirstGreenMs !== null ? ` · avg time-to-first-green ${(rpt.timing.avgTimeToFirstGreenMs / 1000).toFixed(1)}s` : ""}`);
        console.log(`${c.bold("Loop")}          ${rpt.loop.executions} executions · verify_tests pass ${(rpt.loop.verifyPassRate * 100).toFixed(1)}% · ${rpt.loop.thrashOccurrences} thrash · avg ${rpt.loop.avgIterationsPerFailedTask.toFixed(1)} iters/failed task`);
        console.log(`${c.bold("Knowledge")}     ${rpt.knowledge.totalActive} active events across ${Object.keys(rpt.knowledge.byType).length} types`);
        for (const [type, n] of Object.entries(rpt.knowledge.byType).sort((a, b) => b[1] - a[1])) {
          console.log(`              ${c.dim("·")} ${type.padEnd(18)} ${n}`);
        }
        console.log(`${c.bold("Context reuse")} ${(rpt.knowledge.contextReuseRate * 100).toFixed(1)}% ${c.dim("(multiplayer metric — 0 for single-actor)")}`);
        console.log(`${c.bold("Risk coverage")} ${(rpt.knowledge.riskCoverage * 100).toFixed(1)}% ${c.dim("(tasks whose paths overlap a prior failed_attempt/gotcha)")}`);
        if (rpt.notes.length) {
          console.log("");
          console.log(c.dim("Notes"));
          for (const n of rpt.notes) console.log(`  ${c.dim("·")} ${n}`);
        }
        return;
      }
      case "revalidate": {
        // §4.2e — recheck every capability contract against the working tree.
        // Called by the post-merge hook, but the answer is identical whether
        // or not the hook ever ran: validity is DERIVED at pack time too.
        // This only warms the answer.
        const quiet = args.includes("--quiet");
        const { resolveCodeIndex } = await import("../../core/src/knowledge/code-index.ts");
        const { checkContractValidity } = await import("../../core/src/knowledge/validity.ts");
        const root = process.cwd();
        const index = await resolveCodeIndex({ root });
        const rows = db.query(
          "SELECT id, subject, body FROM knowledge_events WHERE type = 'artifact_summary' AND superseded_by IS NULL",
        ).all() as Array<{ id: string; subject: string; body: string }>;

        let valid = 0, drifted = 0, unknown = 0, skipped = 0;
        const drift: string[] = [];
        for (const r of rows) {
          let contract: import("../../core/src/knowledge/contracts.ts").CapabilityContract | null = null;
          try {
            const parsed = JSON.parse(r.body);
            if (parsed?.type === "capability_contract") contract = parsed;
          } catch { /* prose body */ }
          if (!contract) { skipped++; continue; }
          const report = await checkContractValidity(contract, index);
          if (report.status === "valid") valid++;
          else if (report.status === "drifted") {
            drifted++;
            drift.push(`  ${c.amber("~")} ${r.subject}`);
            for (const k of report.changed) drift.push(`      ${c.dim("changed")}  ${k}`);
            for (const k of report.removed) drift.push(`      ${c.dim("removed")}  ${k}`);
          } else unknown++;
        }

        if (quiet) return;
        console.log(`${c.bold("contract validity")}  ${c.green(String(valid) + " valid")} · ${c.amber(String(drifted) + " drifted")} · ${c.dim(String(unknown) + " unverifiable")} · ${c.dim(String(skipped) + " prose")}`);
        if (drift.length) { console.log(""); for (const l of drift) console.log(l); }
        if (unknown > 0) {
          console.log("");
          console.log(c.dim("  unverifiable = emitted before signature hashing, or the code index could not resolve the files."));
          console.log(c.dim("  These are reported as unknown, never as valid."));
        }
        return;
      }
      case "install-hook": {
        const { installPostMergeHook } = await import("../../core/src/knowledge/hooks.ts");
        const res = installPostMergeHook(process.cwd(), { force: args.includes("--force") });
        if (res.installed) {
          console.log(`${c.green("+")} post-merge hook ${res.reason} ${c.dim(res.path ?? "")}`);
          console.log(c.dim("  Optimization only — contract validity is derived at pack time regardless."));
        } else {
          console.error(`${c.red("✗")} ${res.reason}`);
          process.exit(1);
        }
        return;
      }
      case "sync": {
        // §4.6 — push then pull against a relay. Append-only means there is
        // never a conflict to resolve; offline just means the cursors do not
        // advance and the next run sends the same batch.
        const { syncOnce, getSyncState } = await import("../../core/src/knowledge/sync.ts");
        const remote = flagValue(args, "--remote") ?? process.env["AGENT_TRAIL_RELAY_URL"];
        if (!remote) {
          console.error(`${c.red("✗")} usage: agent-trail knowledge sync --remote <url> [--workspace <id>] [--project <id>]`);
          console.error(c.dim("  or set AGENT_TRAIL_RELAY_URL. Token via --token or AGENT_TRAIL_RELAY_TOKEN."));
          process.exit(2);
        }
        const res = await syncOnce(db, {
          remote,
          workspaceId: flagValue(args, "--workspace") ?? "local",
          projectId: flagValue(args, "--project") ?? "local",
          token: flagValue(args, "--token") ?? process.env["AGENT_TRAIL_RELAY_TOKEN"],
          localOnly: args.includes("--local-only"),
        });
        if (res.skipped) {
          console.log(`${c.amber("~")} sync skipped — ${res.reason ?? "unknown"}`);
          const st = getSyncState(db, remote);
          if (st?.lastError) console.log(c.dim(`  last error: ${st.lastError}`));
          process.exit(res.reason?.includes("local-only") ? 0 : 1);
        }
        console.log(`${c.green("+")} pushed ${res.pushed.events} event(s) / ${res.pushed.edges} edge(s) · pulled ${res.pulled.events} / ${res.pulled.edges}`);
        if (res.cursor) console.log(c.dim(`  cursor ${res.cursor}`));
        return;
      }
      default:
        console.log(`${c.bold("agent-trail knowledge")}\n\nUsage:\n  ${c.bold("backfill")}                        Sweep .agent-trail/context/*.md into the event log\n  ${c.bold("ls")} [--type <t>] [--limit <n>]    List active events\n  ${c.bold("fold")} [--cap <chars>]              Preview the constitution projection\n  ${c.bold("export")} [--dir <path>]            Dump JSONL + AGENTS.md + constitution.md\n  ${c.bold("import")} <events.jsonl>            Replay from a JSONL dump (idempotent)\n  ${c.bold("bench")} [--days <n>] [--json]      Report tokens, cache-hit, context-reuse, risk coverage\n  ${c.bold("revalidate")} [--quiet]              Recheck capability contracts against the working tree (§4.2e)\n  ${c.bold("install-hook")} [--force]           Install the post-merge hook that warms revalidate\n  ${c.bold("sync")} --remote <url>               Push/pull the event log against a relay (§4.6)`);
        process.exit(sub ? 1 : 0);
    }
  } finally {
    db.close();
  }
}

// PRD_OPEN_SOURCE §4.1/§4.2 — team library CLI.
//   agent-trail library add <url> [--overwrite]
//   agent-trail library new <name> [--description "..."]
//   agent-trail library ls
//   agent-trail library rm <name>
async function cmdLibrary(args: string[]) {
  const sub = args[0];
  const { addNote: _n } = await import("../../core/src/context/store.ts"); void _n; // side-effect-free import (kept for future use)
  const {
    listAgents, readAgent, saveAgent, deleteAgent, scaffoldAgent, importAgentFromUrl,
  } = await import("../../core/src/library/store.ts");
  const root = process.env["AGENT_TRAIL_ROOT"] ?? resolveProjectRoot();

  if (sub === "add") {
    const positional = args.slice(1).filter((a) => !a.startsWith("--"));
    const url = positional[0];
    const overwrite = args.includes("--overwrite");
    if (!url) {
      console.error(`Usage: agent-trail library add ${c.bold("<url>")} [--overwrite]`);
      process.exit(2);
    }
    const r = await importAgentFromUrl(root, url, { overwrite });
    if (!r.ok) { console.error(`${c.red("✗")} ${r.error}`); process.exit(1); }
    console.log(`${c.green("✓")} imported ${c.bold(r.entry.name)} → ${c.dim(r.entry.path)}`);
    return;
  }

  if (sub === "new") {
    const positional = args.slice(1).filter((a) => !a.startsWith("--"));
    const name = positional[0];
    const description = flagValue(args, "--description");
    if (!name) {
      console.error(`Usage: agent-trail library new ${c.bold("<name>")} [--description "..."]`);
      process.exit(2);
    }
    const scaff = scaffoldAgent(name, description ?? "TODO: describe what this agent is good at");
    const saved = saveAgent(root, scaff, { overwrite: args.includes("--overwrite") });
    if (!saved.ok) { console.error(`${c.red("✗")} ${saved.error}`); process.exit(1); }
    console.log(`${c.green("✓")} scaffold at ${c.bold(saved.path)}`);
    console.log(`  Edit the file and fill in the frontmatter + body.`);
    return;
  }

  if (sub === "ls" || sub === "list") {
    const entries = listAgents(root);
    if (entries.length === 0) {
      console.log(`${c.dim("(empty)")}  Add one: ${c.bold("agent-trail library add <url>")}  or  ${c.bold("agent-trail library new <name>")}`);
      return;
    }
    for (const e of entries) {
      console.log(`  ${c.bold(e.name.padEnd(24))} ${c.dim(e.description.slice(0, 60))}`);
    }
    return;
  }

  if (sub === "rm" || sub === "remove") {
    const name = args[1];
    if (!name) {
      console.error(`Usage: agent-trail library rm ${c.bold("<name>")}`);
      process.exit(2);
    }
    if (!readAgent(root, name)) {
      console.error(`${c.red("✗")} agent "${name}" not found`);
      process.exit(1);
    }
    deleteAgent(root, name);
    console.log(`${c.green("✓")} removed ${c.bold(name)}`);
    return;
  }

  console.error(`Usage: agent-trail library ${c.bold("add|new|ls|rm")} [args]`);
  process.exit(2);
}

// PRD_OPEN_SOURCE §5.4 — Board loop CLI. "Ralph the backlog" —
//   agent-trail loop --board <id> [--budget $2.50] [--timeout 3600]
// Kicks off /run, then polls tasks + cost every 3s and stops on:
//   • every task in a terminal status (done / in_review / blocked / failed)
//   • a decision ticket appearing (human input needed — this is the whole point)
//   • budget threshold crossed
//   • overall timeout
async function cmdLoop(args: string[]) {
  const boardId = flagValue(args, "--board");
  const budgetUsd = Number(flagValue(args, "--budget") ?? 0);
  const timeoutSec = Number(flagValue(args, "--timeout") ?? 3600);
  if (!boardId) {
    console.error(`Usage: agent-trail loop --board ${c.bold("<boardId>")} [--budget <usd>] [--timeout <sec>]`);
    process.exit(2);
  }

  const runRes = await apiFetch(`/api/boards/${boardId}/run`, { method: "POST" });
  if (!runRes.ok) {
    const err = await runRes.text().catch(() => "");
    console.error(`${c.red("✗")} could not start board loop: ${err}`);
    process.exit(1);
  }
  console.log(`${c.dim("▶")} board loop started ${c.dim(`(${boardId.slice(0, 8)})`)}`);
  if (budgetUsd > 0) console.log(`${c.dim("  budget:")} $${budgetUsd.toFixed(2)}`);

  const deadline = Date.now() + timeoutSec * 1000;
  let lastLoggedStatus = "";
  const terminal = new Set(["done", "in_review", "blocked", "failed"]);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));

    const tasks = await (await apiFetch(`/api/boards/${boardId}/tasks`)).json() as Array<{
      id: string; title: string; status: string; lastError: string | null;
    }>;
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" ");
    if (summary !== lastLoggedStatus) {
      console.log(`  ${c.dim("·")} ${summary}`);
      lastLoggedStatus = summary;
    }

    // Watch for a decision ticket on any task — the entire point of the loop
    // is to hand control back to the human at these gates.
    let openTickets = 0;
    for (const t of tasks) {
      try {
        const tickets = await (await apiFetch(`/api/tasks/${t.id}/decisions`)).json() as Array<{ answer: string | null }>;
        openTickets += tickets.filter((tk) => tk.answer === null).length;
      } catch { /* ignore per-task poll errors */ }
    }
    if (openTickets > 0) {
      console.log(`${c.amber("⏸")} ${openTickets} open decision ticket(s) — loop paused for human input.`);
      printBoardSummary(tasks);
      process.exit(2);
    }

    // Budget check.
    if (budgetUsd > 0) {
      const cost = await (await apiFetch(`/api/boards/${boardId}/cost`)).json() as {
        totals: { usd: number };
      };
      if (cost.totals.usd >= budgetUsd) {
        console.log(`${c.red("✗")} budget exceeded — $${cost.totals.usd.toFixed(4)} ≥ $${budgetUsd.toFixed(2)}`);
        printBoardSummary(tasks);
        process.exit(3);
      }
    }

    // Terminal? Every task in a terminal state = loop done.
    if (tasks.every((t) => terminal.has(t.status))) {
      console.log(`${c.green("✓")} board loop finished — every task is in a terminal state.`);
      printBoardSummary(tasks);
      const anyFailed = tasks.some((t) => t.status === "failed" || t.status === "blocked");
      process.exit(anyFailed ? 1 : 0);
    }
  }

  console.error(`${c.red("✗")} timed out after ${timeoutSec}s`);
  process.exit(124);
}

function printBoardSummary(tasks: Array<{ id: string; title: string; status: string; lastError: string | null }>): void {
  console.log("");
  for (const t of tasks) {
    const icon = statusIcon(t.status);
    console.log(`  ${icon} ${t.title} ${c.dim(t.id.slice(0, 8))}${t.lastError ? ` ${c.red("— " + t.lastError.split("\n")[0]!.slice(0, 60))}` : ""}`);
  }
}

// PRD_OPEN_SOURCE 3.1 — export/import the board+task graph as .agent-trail/state.json.
async function cmdSync(args: string[]) {
  const sub = args[0];
  const root = process.env["AGENT_TRAIL_ROOT"] ?? resolveProjectRoot();
  if (sub === "export") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(resolveDbPath(root));
    try {
      const path = exportToFile(db, root);
      console.log(`${c.green("✓")} exported to ${c.bold(path)}`);
    } finally {
      db.close();
    }
    return;
  }
  if (sub === "import") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(resolveDbPath(root));
    try {
      const res = hydrateFromFile(db, root);
      if (!res) {
        console.error(`${c.red("✗")} no state.json at ${c.bold(statePath(root))}`);
        process.exit(1);
      }
      if (res.skippedVersion) {
        console.error(`${c.red("✗")} state.json schema version unknown — nothing imported`);
        process.exit(1);
      }
      console.log(`${c.green("✓")} imported ${res.boardsUpserted} board(s), ${res.tasksUpserted} task(s)`);
    } finally {
      db.close();
    }
    return;
  }
  if (sub === "status") {
    const path = statePath(root);
    const state = readStateFile(root);
    if (!state) {
      console.log(`${c.dim("(no state.json)")}  ${c.dim(path)}`);
      console.log(`  ${c.bold("agent-trail sync export")} to seed it.`);
      return;
    }
    console.log(`${c.bold(path)}`);
    console.log(`  version:   ${state.version}`);
    console.log(`  exported:  ${state.exported_at}`);
    console.log(`  boards:    ${state.boards.length}`);
    console.log(`  tasks:     ${state.tasks.length}`);
    return;
  }
  console.error(`Usage: agent-trail sync ${c.bold("export|import|status")}`);
  process.exit(2);
}

// PRD_OPEN_SOURCE 2.2 — resume a task's previous claude session.
async function cmdResume(taskId: string | undefined) {
  if (!taskId) {
    console.error(`Usage: agent-trail resume ${c.bold("<taskId>")}`);
    process.exit(2);
  }
  const res = await apiFetch(`/api/tasks/${taskId}/resume`, { method: "POST" });
  const body = await res.text();
  if (!res.ok) {
    console.error(`${c.red("✗")} ${body}`);
    process.exit(1);
  }
  console.log(body);
}


// ─── workspace ───────────────────────────────────────────────────────────────
// knowledgelayer §5.1 — relay identity. Run on the RELAY HOST: these commands
// write to the relay's own database, which is where membership lives.
//
//   agent-trail workspace create <id> <name>
//   agent-trail workspace ls
//   agent-trail workspace member add <workspaceId> <externalId> <displayName> [--role member]
//   agent-trail workspace member rm  <workspaceId> <userId>
//   agent-trail workspace token create <workspaceId> <externalId> [--label x] [--ttl-days 90]
//   agent-trail workspace token ls <workspaceId>
//   agent-trail workspace token revoke <tokenId>

async function cmdWorkspace(args: string[]): Promise<void> {
  const W = await import("../../core/src/knowledge/workspace.ts");
  const { Database } = await import("bun:sqlite");
  const { resolveDbPath } = await import("../../core/src/storage/paths.ts");
  const db = new Database(resolveDbPath());
  W.ensureWorkspaceSchema(db);

  const sub = args[0];
  try {
    switch (sub) {
      case "create": {
        const id = args[1], name = args[2] ?? args[1];
        if (!id) { console.error(`${c.red("✗")} usage: agent-trail workspace create <id> <name>`); process.exit(2); }
        W.createWorkspace(db, { id, name: name! });
        console.log(`${c.green("+")} workspace ${c.bold(id)} created`);
        return;
      }
      case "ls": {
        const rows = db.query("SELECT id, name, created_at FROM workspaces ORDER BY created_at").all() as Array<{ id: string; name: string; created_at: string }>;
        if (!rows.length) { console.log(c.dim("(no workspaces — try `workspace create`)")); return; }
        for (const r of rows) {
          const members = W.listMembers(db, r.id);
          console.log(`${c.bold(r.id)}  ${r.name}  ${c.dim(`${members.length} member(s)`)}`);
          for (const m of members) console.log(`  ${c.dim("·")} ${m.displayName} ${c.dim(`(${m.externalId})`)} — ${m.role}`);
        }
        return;
      }
      case "member": {
        const action = args[1];
        if (action === "add") {
          const [, , ws, externalId, displayName] = args;
          if (!ws || !externalId || !displayName) {
            console.error(`${c.red("✗")} usage: agent-trail workspace member add <workspaceId> <externalId> <displayName> [--role member]`);
            console.error(c.dim("  externalId should be stable, e.g. github:12345 — never a renameable login."));
            process.exit(2);
          }
          const role = (flagValue(args, "--role") ?? "member") as import("../../core/src/knowledge/workspace.ts").Role;
          if (!W.ROLES.includes(role)) { console.error(`${c.red("✗")} role must be one of ${W.ROLES.join(", ")}`); process.exit(2); }
          const user = W.upsertUser(db, { externalId, displayName });
          W.addMember(db, ws, user.id, role);
          console.log(`${c.green("+")} ${displayName} added to ${c.bold(ws)} as ${role} ${c.dim(`(user ${user.id})`)}`);
          return;
        }
        if (action === "rm") {
          const [, , ws, userId] = args;
          if (!ws || !userId) { console.error(`${c.red("✗")} usage: agent-trail workspace member rm <workspaceId> <userId>`); process.exit(2); }
          W.removeMember(db, ws, userId);
          console.log(`${c.green("+")} removed ${userId} from ${ws} ${c.dim("(their tokens for this workspace were revoked)")}`);
          return;
        }
        console.error(`${c.red("✗")} usage: agent-trail workspace member add|rm …`);
        process.exit(2);
        return;
      }
      case "token": {
        const action = args[1];
        if (action === "create") {
          const [, , ws, externalId] = args;
          if (!ws || !externalId) { console.error(`${c.red("✗")} usage: agent-trail workspace token create <workspaceId> <externalId> [--label x] [--ttl-days 90]`); process.exit(2); }
          const userRow = db.query("SELECT id FROM workspace_users WHERE external_id = ?").get(externalId) as { id: string } | null;
          if (!userRow) { console.error(`${c.red("✗")} no such user ${externalId} — add them with \`workspace member add\` first`); process.exit(1); }
          if (!W.getRole(db, ws, userRow!.id)) { console.error(`${c.red("✗")} ${externalId} is not a member of ${ws}`); process.exit(1); }
          const ttl = flagValue(args, "--ttl-days");
          const issued = W.createToken(db, { userId: userRow!.id, workspaceId: ws, label: flagValue(args, "--label"), ttlDays: ttl ? Number(ttl) : undefined });
          console.log(`${c.green("+")} token created for ${externalId} in ${c.bold(ws)}`);
          console.log("");
          console.log(`  ${c.bold(issued.token)}`);
          console.log("");
          // Only chance to see it — the database holds a hash, not this string.
          console.log(c.amber("  Copy it now. It is stored hashed and cannot be shown again."));
          if (issued.expiresAt) console.log(c.dim(`  expires ${issued.expiresAt}`));
          return;
        }
        if (action === "ls") {
          const ws = args[2];
          if (!ws) { console.error(`${c.red("✗")} usage: agent-trail workspace token ls <workspaceId>`); process.exit(2); }
          const rows = W.listTokens(db, ws);
          if (!rows.length) { console.log(c.dim("(no tokens)")); return; }
          for (const t of rows) {
            const state = t.revokedAt ? c.red("revoked") : (t.expiresAt && Date.parse(t.expiresAt) <= Date.now() ? c.amber("expired") : c.green("active"));
            console.log(`${t.id}  ${state}  ${t.label ?? c.dim("(no label)")}  ${c.dim(`last used ${t.lastUsedAt ?? "never"}`)}`);
          }
          return;
        }
        if (action === "revoke") {
          const id = args[2];
          if (!id) { console.error(`${c.red("✗")} usage: agent-trail workspace token revoke <tokenId>`); process.exit(2); }
          console.log(W.revokeToken(db, id)
            ? `${c.green("+")} token ${id} revoked`
            : `${c.amber("~")} token ${id} was already revoked or does not exist`);
          return;
        }
        console.error(`${c.red("✗")} usage: agent-trail workspace token create|ls|revoke …`);
        process.exit(2);
        return;
      }
      default:
        console.log(`${c.bold("agent-trail workspace")}  ${c.dim("(run on the relay host)")}\n\nUsage:\n  ${c.bold("create")} <id> <name>\n  ${c.bold("ls")}\n  ${c.bold("member add")} <ws> <externalId> <displayName> [--role viewer|member|admin|owner]\n  ${c.bold("member rm")} <ws> <userId>\n  ${c.bold("token create")} <ws> <externalId> [--label x] [--ttl-days 90]\n  ${c.bold("token ls")} <ws>\n  ${c.bold("token revoke")} <tokenId>`);
        process.exit(sub ? 1 : 0);
    }
  } finally {
    db.close();
  }
}
