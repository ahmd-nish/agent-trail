/**
 * Per-board dev server lifecycle, owned by the runner process.
 *
 * Differences from the previous (in-server) DevServerManager:
 *   - Children are spawned with `detached: true` so they survive runner death.
 *   - Every state change persists to ~/.inventarium/runner-state.json.
 *   - On boot, the runner adopts any tracked PIDs that are still alive.
 *
 * Logs are kept in-memory only (ring buffer). If the runner dies, the buffer
 * resets but the child stays running and continues writing to its own stdout —
 * we just can't capture lines emitted while we were down.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { loadState, saveState, pidIsAlive, type PersistedServer } from "./state.ts";

const MAX_LOG_LINES = 500;
const PORT_DETECT_WINDOW_MS = 8000;
const REACHABILITY_TIMEOUT_MS = 500;
const REACHABILITY_CACHE_MS = 1000;

export interface DevServerStatus {
  state: "running" | "stopped" | "starting" | "crashed" | "adopted";
  pid: number | null;
  port: number | null;
  command: string | null;
  cwd: string | null;
  uptimeMs: number | null;
  startedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  logsAvailable: number;
  portReachable: boolean | null;
}

export interface LogLine { ts: number; stream: "stdout" | "stderr"; text: string; }

interface ServerEntry {
  boardId: string;
  proc: ChildProcess | null;          // null when adopted (we don't own the stdio)
  state: DevServerStatus["state"];
  pid: number | null;
  port: number | null;
  command: string;
  cwd: string;
  startedAt: number | null;
  lastExitCode: number | null;
  lastError: string | null;
  logs: LogLine[];
  portScanUntil: number;
  reachable: boolean | null;
  reachableAt: number;
}

class Manager {
  private servers = new Map<string, ServerEntry>();

  /**
   * Re-attach to any dev servers tracked in the on-disk state file that are
   * still alive. Drop stale entries. Called once at boot.
   */
  bootstrap(): { adopted: number; dropped: number } {
    const state = loadState();
    let adopted = 0;
    let dropped = 0;
    for (const [boardId, p] of Object.entries(state.servers)) {
      if (pidIsAlive(p.pid)) {
        this.servers.set(boardId, {
          boardId,
          proc: null, // we can't recover stdio streams across reboots
          state: "adopted",
          pid: p.pid,
          port: p.port,
          command: p.command,
          cwd: p.cwd,
          startedAt: p.startedAt,
          lastExitCode: null,
          lastError: null,
          logs: [],
          portScanUntil: 0,
          reachable: null,
          reachableAt: 0,
        });
        adopted++;
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      // Persist the cleaned-up state
      this.persist();
    }
    return { adopted, dropped };
  }

  async status(boardId: string): Promise<DevServerStatus> {
    const e = this.servers.get(boardId);
    if (!e) return emptyStatus();
    const liveState: DevServerStatus["state"] = e.state === "adopted" && e.pid && !pidIsAlive(e.pid)
      ? "stopped"
      : e.state;
    if (liveState !== e.state) {
      e.state = liveState;
      e.pid = null;
      this.persist();
    }

    const now = Date.now();
    const canProbe = (e.state === "running" || e.state === "adopted") && e.port != null;
    if (canProbe && now - e.reachableAt > REACHABILITY_CACHE_MS) {
      e.reachable = await probePort(e.port!);
      e.reachableAt = now;
    } else if (!canProbe) {
      e.reachable = null;
    }

    return {
      state: e.state,
      pid: e.pid,
      port: e.port,
      command: e.command || null,
      cwd: e.cwd || null,
      uptimeMs: e.startedAt ? Date.now() - e.startedAt : null,
      startedAt: e.startedAt ? new Date(e.startedAt).toISOString() : null,
      lastExitCode: e.lastExitCode,
      lastError: e.lastError,
      logsAvailable: e.logs.length,
      portReachable: e.reachable,
    };
  }

  start(boardId: string, command: string, cwd: string, declaredPort: number | null): { ok: true } | { ok: false; error: string } {
    const existing = this.servers.get(boardId);
    if (existing && (existing.state === "running" || existing.state === "starting" || existing.state === "adopted")) {
      // If adopted is alive, that counts as already running.
      if (existing.pid && pidIsAlive(existing.pid)) {
        return { ok: false, error: `Already running (pid ${existing.pid})` };
      }
    }
    if (!existsSync(cwd)) return { ok: false, error: `Implementation directory does not exist: ${cwd}` };
    if (!command.trim()) return { ok: false, error: "Dev command is empty" };

    const entry: ServerEntry = existing ?? {
      boardId, proc: null, state: "starting", pid: null, port: declaredPort,
      command, cwd, startedAt: null, lastExitCode: null, lastError: null,
      logs: [], portScanUntil: 0, reachable: null, reachableAt: 0,
    };
    entry.state = "starting";
    entry.command = command;
    entry.cwd = cwd;
    entry.port = declaredPort;
    entry.startedAt = null;
    entry.lastExitCode = null;
    entry.lastError = null;
    entry.logs = [];
    entry.portScanUntil = Date.now() + PORT_DETECT_WINDOW_MS;
    entry.reachable = null;
    entry.reachableAt = 0;
    this.servers.set(boardId, entry);

    try {
      // detached + new session: the child becomes its own process group leader,
      // so when the runner dies the dev server keeps running. We do NOT call
      // proc.unref() because we want to capture stdout/stderr while we're alive.
      const proc = spawn(command, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      entry.proc = proc;
      entry.pid = proc.pid ?? null;
      entry.startedAt = Date.now();
      entry.state = "running";

      proc.stdout?.setEncoding("utf-8");
      proc.stderr?.setEncoding("utf-8");

      const onChunk = (stream: "stdout" | "stderr") => (raw: string) => {
        for (const line of raw.split("\n")) {
          if (!line) continue;
          this.append(entry, stream, line);
          if (entry.port == null && Date.now() < entry.portScanUntil) {
            const m = line.match(/(?::|port[\s:=]+)(\d{2,5})\b/i);
            if (m) {
              const n = Number(m[1]);
              if (n >= 1 && n <= 65535) {
                entry.port = n;
                this.persist();
              }
            }
          }
        }
      };
      proc.stdout?.on("data", onChunk("stdout"));
      proc.stderr?.on("data", onChunk("stderr"));

      proc.on("error", (err) => {
        entry.state = "crashed";
        entry.lastError = err.message;
        this.append(entry, "stderr", `[runner] spawn error: ${err.message}`);
        this.persist();
      });
      proc.on("exit", (code, signal) => {
        entry.state = code === 0 || signal === "SIGTERM" ? "stopped" : "crashed";
        entry.lastExitCode = code;
        entry.pid = null;
        this.append(entry, "stderr", `[runner] process exited (code=${code} signal=${signal ?? "-"})`);
        this.persist();
      });

      this.persist();
      return { ok: true };
    } catch (err) {
      entry.state = "crashed";
      entry.lastError = err instanceof Error ? err.message : String(err);
      this.persist();
      return { ok: false, error: entry.lastError };
    }
  }

  stop(boardId: string): { ok: boolean } {
    const e = this.servers.get(boardId);
    if (!e || !e.pid) return { ok: false };
    try {
      // Kill the whole process group so shells, watchers, and grandchildren all go.
      // pgid === pid because we spawned with detached:true.
      try { process.kill(-e.pid, "SIGTERM"); }
      catch { try { process.kill(e.pid, "SIGTERM"); } catch { /* gone */ } }

      setTimeout(() => {
        if (e.pid && pidIsAlive(e.pid)) {
          try { process.kill(-e.pid!, "SIGKILL"); }
          catch { try { process.kill(e.pid!, "SIGKILL"); } catch { /* gone */ } }
        }
      }, 3000);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  recentLogs(boardId: string, limit = 100): LogLine[] {
    const e = this.servers.get(boardId);
    if (!e) return [];
    return e.logs.slice(-limit);
  }

  /** Snapshot serializable state for persistence. */
  private persist(): void {
    const state = loadState();
    state.servers = {};
    for (const [boardId, e] of this.servers) {
      if (!e.pid) continue;
      const p: PersistedServer = {
        boardId,
        pid: e.pid,
        port: e.port,
        command: e.command,
        cwd: e.cwd,
        startedAt: e.startedAt ?? Date.now(),
      };
      state.servers[boardId] = p;
    }
    saveState(state);
  }

  private append(e: ServerEntry, stream: "stdout" | "stderr", text: string): void {
    e.logs.push({ ts: Date.now(), stream, text });
    if (e.logs.length > MAX_LOG_LINES) e.logs.splice(0, e.logs.length - MAX_LOG_LINES);
  }
}

function emptyStatus(): DevServerStatus {
  return {
    state: "stopped", pid: null, port: null, command: null, cwd: null,
    uptimeMs: null, startedAt: null, lastExitCode: null, lastError: null,
    logsAvailable: 0, portReachable: null,
  };
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(ok);
    };
    sock.setTimeout(REACHABILITY_TIMEOUT_MS);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
    try { sock.connect(port, "127.0.0.1"); } catch { finish(false); }
  });
}

export const manager = new Manager();
