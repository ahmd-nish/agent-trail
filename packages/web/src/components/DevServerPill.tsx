import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Square, RotateCcw, Wand2, AlertTriangle } from "lucide-react";
import type { Board } from "../../../core/src/types/index.ts";
import { api, type DevServerStatus, type DevLogLine } from "../lib/api.ts";

interface Props {
  board: Board;
  onBoardUpdated: (b: Board) => void;
}

const STATE_LABELS: Record<DevServerStatus["state"], string> = {
  running: "Running",
  starting: "Starting…",
  stopped: "Stopped",
  crashed: "Crashed",
};

const STATE_DOT: Record<DevServerStatus["state"], string> = {
  running: "bg-emerald-500",
  starting: "bg-amber-400 animate-pulse",
  stopped: "bg-slate-500",
  crashed: "bg-red-500",
};

const STATE_TEXT: Record<DevServerStatus["state"], string> = {
  running: "text-emerald-300",
  starting: "text-amber-300",
  stopped: "text-slate-400",
  crashed: "text-red-300",
};

function fmtUptime(ms: number | null): string {
  if (!ms || ms < 1000) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function DevServerPill({ board, onBoardUpdated }: Props) {
  const [status, setStatus] = useState<DevServerStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [cmd, setCmd] = useState(board.devCommand ?? "");
  const [port, setPort] = useState<string>(board.devPort?.toString() ?? "");
  const [acting, setActing] = useState(false);
  const [logs, setLogs] = useState<DevLogLine[]>([]);
  const [savingCfg, setSavingCfg] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  // ── Poll status while the board is open. Cheap GET, every 3s.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const s = await api.dev.status(board.id).catch(() => null);
      if (!cancelled && s) setStatus(s);
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [board.id]);

  // ── Sync command/port inputs whenever the board prop changes
  useEffect(() => {
    setCmd(board.devCommand ?? "");
    setPort(board.devPort?.toString() ?? "");
  }, [board.id, board.devCommand, board.devPort]);

  // ── Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // ── Fetch logs (poll while popover open)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      const lines = await api.dev.logs(board.id, 80).catch(() => null);
      if (!cancelled && lines) setLogs(lines);
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [open, board.id]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  // ── Actions

  async function autoDetect() {
    try {
      const r = await api.dev.detect(board.id);
      if (r.command) setCmd(r.command);
      if (r.port != null) setPort(String(r.port));
    } catch (err) {
      alert(`Auto-detect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function saveConfig() {
    setSavingCfg(true);
    try {
      const updated = await api.boards.update(board.id, {
        devCommand: cmd.trim() || null,
        devPort: port.trim() ? Number(port) : null,
      });
      onBoardUpdated(updated);
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingCfg(false);
    }
  }

  const start = useCallback(async (override?: { command?: string; port?: number | null }) => {
    setActing(true);
    try {
      const next = await api.dev.start(board.id, override);
      setStatus(next);
    } catch (err) {
      alert(`Start failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActing(false);
    }
  }, [board.id]);

  async function stop() {
    setActing(true);
    try {
      const r = await api.dev.stop(board.id);
      setStatus(r.status);
    } finally {
      setActing(false);
    }
  }

  async function restart() {
    setActing(true);
    try {
      await api.dev.stop(board.id);
      // Tiny grace so SIGTERM finishes before respawn
      await new Promise((r) => setTimeout(r, 300));
      const next = await api.dev.start(board.id);
      setStatus(next);
    } catch (err) {
      alert(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActing(false);
    }
  }

  const state = status?.state ?? "stopped";
  const portLabel = status?.port ?? board.devPort ?? null;
  const isRunning = state === "running";
  const unreachable = isRunning && status?.portReachable === false;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((x) => !x)}
        className="flex items-center gap-1.5 text-[10px] px-2 py-1 rounded border border-slate-700 bg-slate-800/60 hover:bg-slate-800 transition-colors"
        title={unreachable
          ? `Process running but port :${portLabel} not responding`
          : `Dev server: ${STATE_LABELS[state]}${portLabel ? ` on :${portLabel}` : ""}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${unreachable ? "bg-amber-400" : STATE_DOT[state]}`} />
        <span className={`flex items-center gap-1 ${unreachable ? "text-amber-300" : STATE_TEXT[state]}`}>
          Dev{portLabel ? `: :${portLabel}` : ""}
          {unreachable && <AlertTriangle size={10} className="shrink-0" />}
        </span>
        {!isRunning && (cmd || board.devCommand) && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); start(); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); start(); } }}
            className="ml-1 px-1 rounded bg-indigo-700/80 hover:bg-indigo-600 text-white cursor-pointer flex items-center"
          >
            <Play size={9} />
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-30 w-96 bg-slate-900 border border-slate-700 rounded-lg shadow-xl p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-200">Dev server</p>
            <span className={`text-[10px] font-medium ${unreachable ? "text-amber-300" : STATE_TEXT[state]}`}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${unreachable ? "bg-amber-400" : STATE_DOT[state]}`} />
              {unreachable ? `Running but :${portLabel} not responding` : STATE_LABELS[state]}
              {status?.pid && ` · pid ${status.pid}`}
              {status?.uptimeMs && ` · ${fmtUptime(status.uptimeMs)}`}
            </span>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">Command</span>
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder="bun run dev"
              className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none placeholder:text-slate-600"
            />
          </label>

          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 w-24">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider">Port</span>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="3100"
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none placeholder:text-slate-600"
              />
            </label>
            <button
              onClick={autoDetect}
              className="text-[10px] px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center gap-1"
              title="Read package.json for a sensible default"
            >
              <Wand2 size={10} /> Auto-detect
            </button>
            <button
              onClick={saveConfig}
              disabled={savingCfg}
              className="text-[10px] px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40"
            >
              {savingCfg ? "Saving…" : "Save"}
            </button>
          </div>

          {/* Action row */}
          <div className="flex gap-2">
            {isRunning ? (
              <>
                <button
                  onClick={stop}
                  disabled={acting}
                  className="flex-1 text-xs px-3 py-1.5 rounded bg-red-900/60 hover:bg-red-800 text-red-200 border border-red-800/50 disabled:opacity-40 flex items-center justify-center gap-1.5"
                >
                  <Square size={11} /> Stop
                </button>
                <button
                  onClick={restart}
                  disabled={acting}
                  className="flex-1 text-xs px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40 flex items-center justify-center gap-1.5"
                >
                  <RotateCcw size={11} /> Restart
                </button>
              </>
            ) : (
              <button
                onClick={() => start({ command: cmd.trim() || undefined, port: port.trim() ? Number(port) : undefined })}
                disabled={acting || !cmd.trim()}
                className="flex-1 text-xs px-3 py-1.5 rounded bg-indigo-700 hover:bg-indigo-600 text-white font-medium disabled:opacity-40 flex items-center justify-center gap-1.5"
              >
                <Play size={11} />
                {acting ? "Starting…" : "Start dev server"}
              </button>
            )}
          </div>

          {status?.cwd && (
            <p className="text-[10px] text-slate-600 truncate" title={status.cwd}>
              cwd: <span className="font-mono">{status.cwd}</span>
            </p>
          )}

          {status?.lastError && state === "crashed" && (
            <p className="text-[10px] text-red-300 bg-red-950/40 border border-red-800/40 rounded px-2 py-1">
              {status.lastError}
            </p>
          )}

          {/* Logs */}
          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              Logs {status?.logsAvailable ? `(${status.logsAvailable})` : ""}
            </p>
            <div
              ref={logBoxRef}
              className="bg-slate-950 border border-slate-800 rounded p-2 max-h-44 overflow-y-auto flex flex-col gap-0.5 font-mono text-[10px] leading-relaxed"
            >
              {logs.length === 0 ? (
                <p className="text-slate-700 italic">No logs yet.</p>
              ) : (
                logs.map((l, i) => (
                  <p key={i} className={l.stream === "stderr" ? "text-red-300" : "text-slate-300"}>
                    {l.text}
                  </p>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
