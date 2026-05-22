import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Task, TddPhase } from "../types/index.ts";
import type { StreamEvent, StreamResultEvent } from "../types/stream-json.ts";

export interface AdapterCallbacks {
  onEvent(raw: string, parsed: StreamEvent): void;
  onComplete(result: StreamResultEvent): void;
  onError(err: Error): void;
}

const PHASE_INSTRUCTIONS: Record<TddPhase, string> = {
  write_tests: `PHASE: write_tests
Your ONLY job is to write failing tests that define the expected behaviour of this task.
Do NOT implement any production code yet — tests should fail because the implementation does not exist.
Use the project's existing test framework (bun:test if available).`,

  implement: `PHASE: implement
Tests have already been written. Write the minimum production code needed to make them pass.
Do NOT modify existing tests. Run tests after implementing to confirm they pass.`,

  verify_tests: `PHASE: verify_tests
Run the test suite and report results. Do NOT modify any code.
Return exit code 0 only if all tests pass.`,

  implement_only: `PHASE: implement_only
No TDD gate — implement the full solution as described.`,
};

function buildSystemPrompt(task: Task): string {
  const parts = [
    "You are Claude Code executing a task inside an agent-trail pipeline.",
    "",
    PHASE_INSTRUCTIONS[task.tddPhase],
  ];
  if (task.skills.length > 0) {
    parts.push(`\nSuggested skills: ${task.skills.join(", ")}`);
  }
  return parts.join("\n");
}

function buildUserPrompt(task: Task): string {
  return [`Task: ${task.title}`, "", task.description || "(no description)"].join("\n");
}

export interface SpawnOpts {
  task: Task;
  worktreePath: string;
  mcpConfigPath: string | null;
  callbacks: AdapterCallbacks;
}

export function spawnClaudeCode({ task, worktreePath, mcpConfigPath, callbacks }: SpawnOpts): void {
  if (!Bun.which("claude")) {
    callbacks.onError(
      new Error(
        "claude CLI not found in PATH — install from https://claude.ai/download and authenticate with `claude login`",
      ),
    );
    return;
  }

  const args: string[] = [
    "-p",
    buildUserPrompt(task),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt",
    buildSystemPrompt(task),
  ];

  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  const proc = spawn("claude", args, {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let resultReceived = false;

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as StreamEvent;
      callbacks.onEvent(trimmed, parsed);
      if (parsed.type === "result") {
        resultReceived = true;
        callbacks.onComplete(parsed as StreamResultEvent);
      }
    } catch {
      // non-JSON line — ignore
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text && !text.startsWith("Warning:")) {
      console.error(`[claude-code:${task.id}] ${text}`);
    }
  });

  proc.on("error", (err) => {
    callbacks.onError(new Error(`Failed to spawn claude: ${err.message}`));
  });

  proc.on("close", (code) => {
    if (!resultReceived && code !== 0) {
      callbacks.onError(new Error(`claude exited with code ${code} without emitting a result event`));
    }
  });
}
