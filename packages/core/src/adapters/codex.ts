// PRD_OPEN_SOURCE 2.4 — Codex CLI adapter skeleton.
//
// This is a "write an adapter in 30 minutes" starter. It follows the shape
// of claude-code.ts: spawn the CLI, translate its stream into StreamEvents,
// call the shared callbacks. Fill in TODO markers to ship a real adapter.
//
// The mock path (via AGENT_TRAIL_CLAUDE_MOCK equivalent) is intentionally
// omitted here — copy that pattern from claude-code.ts when you need
// server-level E2E without hitting the real CLI.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { SpawnOpts } from "./agent-adapter.ts";
import type { StreamEvent, StreamResultEvent } from "../types/stream-json.ts";
import { registerAdapter } from "./agent-adapter.ts";

export function spawnCodex({
  task, worktreePath, permissionMode, timeoutMs, resumeSessionId, callbacks,
}: SpawnOpts): ChildProcess | null {
  if (!Bun.which("codex")) {
    callbacks.onError(new Error(
      "codex CLI not found in PATH — see https://github.com/openai/codex-cli for install",
    ));
    return null;
  }

  // TODO: adapt the flag names to whatever codex CLI actually accepts.
  // Below is a best-guess wireframe. Consult `codex --help` for real names.
  const args = [
    "exec",
    "--stream-json",
    "--permission-mode", permissionMode,
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    "-p", buildPrompt(task),
  ];

  const proc = spawn("codex", args, {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  let resultReceived = false;
  let timedOut = false;

  const killTimer = timeoutMs && timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        try { process.kill(-proc.pid!, "SIGTERM"); } catch { /* gone */ }
        callbacks.onError(new Error(`codex CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs)
    : null;

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      // TODO: codex may emit a different event schema — normalise to our
      // StreamEvent shape here (see ../types/stream-json.ts). For now assume
      // the CLI already emits compatible events.
      const parsed = JSON.parse(line) as StreamEvent;
      callbacks.onEvent(line, parsed);
      if (parsed.type === "result") {
        resultReceived = true;
        callbacks.onComplete(parsed as StreamResultEvent);
      }
    } catch { /* skip malformed lines */ }
  });

  proc.on("close", (code, signal) => {
    if (killTimer) clearTimeout(killTimer);
    if (timedOut) return;
    if (!resultReceived) {
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        callbacks.onError(new Error(`codex was cancelled (signal ${signal})`));
      } else if (code !== 0) {
        callbacks.onError(new Error(`codex exited ${code} without a result event`));
      }
    }
  });

  return proc;
}

function buildPrompt(task: { title: string; description: string }): string {
  const parts = [`Task: ${task.title}`, "", task.description || "(no description)"];
  return parts.join("\n");
}

// Only register when the binary is actually installed — otherwise the UI
// shouldn't offer "codex" as a picker option. Board settings can override.
if (Bun.which?.("codex")) {
  registerAdapter("codex", spawnCodex);
}
