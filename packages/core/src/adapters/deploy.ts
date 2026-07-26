import { spawn } from "node:child_process";

// PRD_OPEN_SOURCE §5.6 — deploy agent.
//
// The deploy path is HIGH blast radius, so:
//   • Always human-gated: caller opens a decision ticket first, only calls
//     into runDeploy() once the ticket is answered "yes".
//   • Command runs with a hard timeout + output cap (matches every other
//     subprocess in this codebase).
//   • Post-deploy healthcheck. Failure → auto-run the target's
//     rollback_command (if configured) and mark the deploy row failed.
//
// This module is pure — no DB access. The route wires it up.

const DEFAULT_TIMEOUT_MS = 10 * 60_000;       // 10 minutes
const OUTPUT_CAP_BYTES   = 200_000;           // ~200 KB per run
const HEALTHCHECK_TIMEOUT_MS = 15_000;
const HEALTHCHECK_ATTEMPTS = 6;
const HEALTHCHECK_INTERVAL_MS = 3_000;

export interface DeployTarget {
  name: string;
  kind: string;                        // MVP: "shell" only, but future-proof
  command: string;
  workingDir?: string | null;
  healthcheckUrl?: string | null;
  rollbackCommand?: string | null;
}

export interface DeployResult {
  ok: boolean;
  status: "success" | "healthcheck_failed" | "command_failed" | "rolled_back" | "timed_out";
  commandOutput: string;
  healthcheckStatus?: string;
  rollbackOutput?: string;
  durationMs: number;
}

export interface RunDeployOptions {
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests — bypass spawning a real process. */
  runCommandImpl?: (cmd: string, cwd?: string, timeoutMs?: number) => Promise<{ ok: boolean; output: string; timedOut: boolean }>;
  /** Test override for the healthcheck retry cadence. */
  healthcheckAttempts?: number;
  healthcheckIntervalMs?: number;
}

export async function runDeploy(target: DeployTarget, opts: RunDeployOptions = {}): Promise<DeployResult> {
  const start = Date.now();
  const runCmd = opts.runCommandImpl ?? runShell;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const cmdRes = await runCmd(target.command, target.workingDir ?? undefined, timeoutMs);
  if (cmdRes.timedOut) {
    return {
      ok: false, status: "timed_out",
      commandOutput: cmdRes.output, durationMs: Date.now() - start,
    };
  }
  if (!cmdRes.ok) {
    // Command failed BEFORE we could healthcheck. Roll back if configured.
    const rb = target.rollbackCommand
      ? await runCmd(target.rollbackCommand, target.workingDir ?? undefined, timeoutMs).catch((err) => ({
          ok: false, output: `rollback threw: ${err instanceof Error ? err.message : String(err)}`, timedOut: false,
        }))
      : null;
    return {
      ok: false,
      status: rb ? "rolled_back" : "command_failed",
      commandOutput: cmdRes.output,
      rollbackOutput: rb?.output,
      durationMs: Date.now() - start,
    };
  }

  // Deploy command succeeded. Healthcheck?
  if (!target.healthcheckUrl) {
    return { ok: true, status: "success", commandOutput: cmdRes.output, durationMs: Date.now() - start };
  }

  const hc = await pollHealthcheck(
    target.healthcheckUrl,
    opts.fetchImpl ?? fetch,
    opts.healthcheckAttempts ?? HEALTHCHECK_ATTEMPTS,
    opts.healthcheckIntervalMs ?? HEALTHCHECK_INTERVAL_MS,
  );
  if (hc.ok) {
    return {
      ok: true, status: "success",
      commandOutput: cmdRes.output, healthcheckStatus: `passed after ${hc.attempts} attempt(s)`,
      durationMs: Date.now() - start,
    };
  }

  // Deploy shipped but health failed → roll back.
  const rb = target.rollbackCommand
    ? await runCmd(target.rollbackCommand, target.workingDir ?? undefined, timeoutMs).catch((err) => ({
        ok: false, output: `rollback threw: ${err instanceof Error ? err.message : String(err)}`, timedOut: false,
      }))
    : null;
  return {
    ok: false,
    status: rb ? "rolled_back" : "healthcheck_failed",
    commandOutput: cmdRes.output,
    healthcheckStatus: `failed after ${hc.attempts} attempts (${hc.reason})`,
    rollbackOutput: rb?.output,
    durationMs: Date.now() - start,
  };
}

// ─── Shell runner ────────────────────────────────────────────────────────────
async function runShell(cmd: string, cwd: string | undefined, timeoutMs: number): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", cmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const kill = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    }, timeoutMs);
    const push = (b: Buffer) => {
      const room = OUTPUT_CAP_BYTES - bytes;
      if (room <= 0) return;
      const slice = b.length <= room ? b : b.subarray(0, room);
      chunks.push(slice);
      bytes += slice.length;
    };
    proc.stdout?.on("data", push);
    proc.stderr?.on("data", push);
    proc.on("close", (code) => {
      clearTimeout(kill);
      const output = Buffer.concat(chunks).toString("utf8");
      const capped = bytes >= OUTPUT_CAP_BYTES ? `${output}\n[output truncated at ${OUTPUT_CAP_BYTES} bytes]` : output;
      resolve({ ok: !timedOut && code === 0, output: capped, timedOut });
    });
    proc.on("error", (err) => {
      clearTimeout(kill);
      resolve({ ok: false, output: `spawn error: ${err.message}`, timedOut: false });
    });
  });
}

async function pollHealthcheck(url: string, fetchImpl: typeof fetch, attempts: number, intervalMs: number): Promise<{ ok: boolean; attempts: number; reason?: string }> {
  let lastReason = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS) });
      if (res.ok) return { ok: true, attempts: attempt };
      lastReason = `${res.status}`;
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return { ok: false, attempts, reason: lastReason };
}
