import { useState, useEffect, useMemo, useRef } from "react";
import { Play, AlertTriangle, Check, X } from "lucide-react";
import type { Task, TaskStatus } from "../../../core/src/types/index.ts";
import { api, type BlockerInfo } from "../lib/api.ts";

interface Props {
  tasks: Task[];
  boardId: string;
  onTaskClick: (task: Task) => void;
  onRunning: () => void;
}

// ─── Status styling ───────────────────────────────────────────────────────────

const STATUS_BG: Record<TaskStatus, string> = {
  backlog:     "bg-slate-700/70 text-slate-400",
  ready:       "bg-blue-900/60 text-blue-300",
  in_progress: "bg-amber-900/60 text-amber-300",
  blocked:     "bg-red-900/60 text-red-300",
  in_review:   "bg-purple-900/60 text-purple-300",
  done:        "bg-emerald-900/60 text-emerald-300",
};

const STATUS_DOT: Record<TaskStatus, string> = {
  backlog:     "bg-slate-500",
  ready:       "bg-blue-400",
  in_progress: "bg-amber-400",
  blocked:     "bg-red-400",
  in_review:   "bg-purple-400",
  done:        "bg-emerald-400",
};

const PRIORITY_BORDER: Record<string, string> = {
  critical: "border-l-red-500",
  high:     "border-l-amber-500",
  medium:   "border-l-blue-500",
  low:      "border-l-slate-700",
};

const PRIORITY_LABEL: Record<string, string> = {
  critical: "text-red-400",
  high:     "text-amber-400",
  medium:   "text-blue-400",
  low:      "text-slate-500",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pct(tasks: Task[]) {
  if (tasks.length === 0) return 0;
  return Math.round((tasks.filter((t) => t.status === "done").length / tasks.length) * 100);
}

function naturalSort(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Spinner({ size = "sm" }: { size?: "xs" | "sm" | "md" }) {
  const dim = size === "xs" ? "w-2.5 h-2.5 border" : size === "sm" ? "w-3.5 h-3.5 border-2" : "w-4 h-4 border-2";
  return (
    <span className={`${dim} rounded-full border-white/20 border-t-white animate-spin shrink-0 inline-block`} />
  );
}

// Elapsed timer — counts up from task.updatedAt when in_progress
function ElapsedTimer({ since }: { since: string }) {
  const [secs, setSecs] = useState(() => Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000)));
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    ref.current = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [since]);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return <span className="text-[10px] tabular-nums text-amber-500/80">{m > 0 ? `${m}m ` : ""}{s}s</span>;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 ${STATUS_BG[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function BlockerAlert({ blockers, onDismiss }: { blockers: BlockerInfo[]; onDismiss: () => void }) {
  return (
    <div className="bg-red-950/50 border border-red-800/50 rounded-lg p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold text-red-400 flex items-center gap-1.5">
          <AlertTriangle size={12} className="shrink-0" />
          Cannot start — {blockers.length} unmet {blockers.length === 1 ? "dependency" : "dependencies"}
        </p>
        <button onClick={onDismiss} className="text-red-700 hover:text-red-400 leading-none shrink-0 flex items-center"><X size={14} /></button>
      </div>
      <div className="flex flex-col gap-1.5">
        {blockers.map((b, i) => (
          <div key={i} className="text-xs text-slate-300 leading-relaxed">
            <span className="text-red-300 font-medium">"{b.taskTitle}"</span>
            <span className="text-slate-500"> is waiting for </span>
            <span className="text-slate-200 font-medium">"{b.blockedByTitle}"</span>
            {(b.blockedByEpic || b.blockedBySprint) && (
              <span className="text-slate-500">
                {" — "}
                {[b.blockedByEpic, b.blockedBySprint].filter(Boolean).join(" / ")}
                {" · "}
                <span className={STATUS_BG[b.blockedByStatus as TaskStatus]?.split(" ")[1] ?? "text-slate-400"}>
                  {b.blockedByStatus.replace("_", " ")}
                </span>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RunButton({
  label,
  loading,
  disabled,
  runningCount = 0,
  onClick,
  size = "sm",
}: {
  label: string;
  loading: boolean;
  disabled: boolean;
  runningCount?: number;
  onClick: () => void;
  size?: "sm" | "xs";
}) {
  const base = size === "sm"
    ? "text-xs px-3 py-1.5 rounded-lg font-medium"
    : "text-[11px] px-2.5 py-1 rounded font-medium";

  const isActivelyRunning = disabled && !loading;

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={loading || disabled}
      className={`${base} flex items-center gap-1.5 shrink-0 transition-all ${
        isActivelyRunning
          ? "bg-amber-800/60 border border-amber-700/50 text-amber-200 cursor-default"
          : "bg-violet-700 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-white"
      }`}
    >
      {loading ? (
        <><Spinner size="xs" /> Starting…</>
      ) : isActivelyRunning ? (
        <><Spinner size="xs" /> {runningCount > 0 ? `${runningCount} running` : "Running"}</>
      ) : (
        <><Play size={11} /> {label}</>
      )}
    </button>
  );
}

function ProgressBar({ done, total, thin }: { done: number; total: number; thin?: boolean }) {
  const p = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className={`flex-1 ${thin ? "h-1" : "h-1.5"} bg-slate-700/80 rounded-full overflow-hidden min-w-0`}>
        <div
          className={`h-full rounded-full transition-all ${p === 100 ? "bg-emerald-500" : "bg-violet-500"}`}
          style={{ width: `${p}%` }}
        />
      </div>
      <span className="text-[10px] text-slate-500 shrink-0 tabular-nums">{done}/{total}</span>
    </div>
  );
}

// ─── Task row ─────────────────────────────────────────────────────────────────

function TaskRow({ task, onClick }: { task: Task; onClick: () => void }) {
  const running = task.status === "in_progress";
  const borderCls = running ? "border-l-amber-500" : (PRIORITY_BORDER[task.priority] ?? "border-l-slate-700");

  // Parse active tool from activeForm SSE snapshot
  let activeTool: string | null = null;
  if (running && task.activeForm) {
    try {
      const ev = JSON.parse(task.activeForm) as { type: string; tool?: string; text?: string };
      if (ev.type === "tool_call" && ev.tool) activeTool = ev.tool;
      else if (ev.type === "text" && ev.text) activeTool = ev.text.slice(0, 32) + (ev.text.length > 32 ? "…" : "");
    } catch { /* ignore */ }
  }

  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3 px-4 py-2.5 border-l-2 ${borderCls} border-b border-slate-800/50 cursor-pointer group transition-colors ${
        running
          ? "bg-amber-950/20 hover:bg-amber-950/30"
          : "hover:bg-slate-800/60"
      }`}
    >
      {/* Status indicator */}
      {running ? (
        <span className="w-3.5 h-3.5 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin shrink-0" />
      ) : (
        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[task.status]}`} />
      )}

      <span className={`flex-1 text-sm group-hover:text-white truncate ${running ? "text-amber-100 font-medium" : "text-slate-200"}`}>
        {task.title}
      </span>

      {/* Active tool label */}
      {running && activeTool && (
        <span className="text-[10px] text-amber-500/70 font-mono truncate max-w-[140px] hidden md:block shrink-0">
          → {activeTool}
        </span>
      )}

      {/* Elapsed timer */}
      {running && (
        <ElapsedTimer since={task.updatedAt} />
      )}

      {task.component && !running && (
        <span className="text-[10px] text-slate-600 shrink-0 hidden lg:block truncate max-w-[100px]">
          {task.component}
        </span>
      )}

      {!running && (
        <span className={`text-[10px] font-semibold shrink-0 ${PRIORITY_LABEL[task.priority] ?? "text-slate-500"}`}>
          {task.priority}
        </span>
      )}

      <StatusBadge status={task.status} />
    </div>
  );
}

// ─── Sprint card ──────────────────────────────────────────────────────────────

function SprintCard({
  sprint,
  tasks,
  loading,
  blockers,
  onRun,
  onTaskClick,
  onDismissBlockers,
}: {
  sprint: string;
  tasks: Task[];
  loading: boolean;
  blockers: BlockerInfo[];
  onRun: () => void;
  onTaskClick: (t: Task) => void;
  onDismissBlockers: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const done = tasks.filter((t) => t.status === "done").length;
  const runningTasks = tasks.filter((t) => t.status === "in_progress");
  const isRunning = runningTasks.length > 0;
  const allDone = done === tasks.length && tasks.length > 0;

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${
      isRunning
        ? "bg-amber-950/10 border-amber-800/40"
        : allDone
          ? "bg-emerald-950/10 border-emerald-800/30"
          : "bg-slate-900 border-slate-700/50"
    }`}>
      {/* Sprint header */}
      <div className={`flex items-center gap-3 px-4 py-3 ${isRunning ? "bg-amber-950/20" : allDone ? "bg-emerald-950/20" : "bg-slate-800/30"}`}>
        <button
          onClick={() => setCollapsed((x) => !x)}
          className="text-slate-600 hover:text-slate-400 shrink-0 transition-transform flex items-center"
          style={{ transform: collapsed ? "none" : "rotate(90deg)", display: "inline-flex" }}
        >
          <Play size={10} />
        </button>

        {isRunning && <Spinner size="xs" />}
        {allDone && <Check size={12} className="text-emerald-500 shrink-0" />}

        <span className={`text-sm font-semibold shrink-0 ${isRunning ? "text-amber-200" : allDone ? "text-emerald-300" : "text-slate-200"}`}>
          {sprint}
        </span>

        <div className="flex-1 min-w-0">
          <ProgressBar done={done} total={tasks.length} thin />
        </div>

        <RunButton
          label="Run Sprint"
          loading={loading}
          disabled={isRunning}
          runningCount={runningTasks.length}
          onClick={onRun}
          size="xs"
        />
      </div>

      {/* Blocker alert */}
      {blockers.length > 0 && (
        <div className="px-4 py-3 border-t border-slate-700/40">
          <BlockerAlert blockers={blockers} onDismiss={onDismissBlockers} />
        </div>
      )}

      {/* Tasks */}
      {!collapsed && (
        <div className="border-t border-slate-700/30">
          {tasks.length === 0 ? (
            <p className="text-xs text-slate-600 px-4 py-3">No tasks in this sprint</p>
          ) : (
            tasks.map((t) => (
              <TaskRow key={t.id} task={t} onClick={() => onTaskClick(t)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Epic sidebar item ────────────────────────────────────────────────────────

function EpicSidebarItem({
  epic,
  tasks,
  active,
  onClick,
}: {
  epic: string;
  tasks: Task[];
  active: boolean;
  onClick: () => void;
}) {
  const done = tasks.filter((t) => t.status === "done").length;
  const p = pct(tasks);
  const isRunning = tasks.some((t) => t.status === "in_progress");
  const hasBlockers = tasks.some((t) => t.status === "blocked");

  return (
    <button
      onClick={onClick}
      className={`w-full flex flex-col gap-1.5 px-4 py-3 text-left border-b border-slate-800/60 transition-colors ${
        active
          ? "bg-violet-950/50 border-l-2 border-l-violet-500"
          : "hover:bg-slate-800/40 border-l-2 border-l-transparent"
      }`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {isRunning
          ? <span className="w-2.5 h-2.5 rounded-full border border-amber-400/30 border-t-amber-400 animate-spin shrink-0" />
          : hasBlockers
            ? <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
            : p === 100
              ? <Check size={12} className="text-emerald-500 shrink-0" />
              : null}
        <span className={`text-sm font-medium truncate ${isRunning ? "text-amber-200" : active ? "text-slate-100" : "text-slate-300"}`}>
          {epic}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1 bg-slate-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${p === 100 ? "bg-emerald-500" : isRunning ? "bg-amber-500/70" : "bg-violet-500/70"}`}
            style={{ width: `${p}%` }}
          />
        </div>
        <span className={`text-[10px] tabular-nums shrink-0 ${active ? "text-slate-400" : "text-slate-500"}`}>
          {done}/{tasks.length}
        </span>
      </div>
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function EpicView({ tasks, boardId, onTaskClick, onRunning }: Props) {
  const [selectedEpic, setSelectedEpic] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [blockersMap, setBlockersMap] = useState<Map<string, BlockerInfo[]>>(new Map());

  // Build epic → task map
  const epicMap = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const e = t.epic ?? "No Epic";
      if (!map.has(e)) map.set(e, []);
      map.get(e)!.push(t);
    }
    return map;
  }, [tasks]);

  const epicNames = useMemo(
    () =>
      [...epicMap.keys()].sort((a, b) => {
        if (a === "No Epic") return 1;
        if (b === "No Epic") return -1;
        return naturalSort(a, b);
      }),
    [epicMap],
  );

  // Auto-select first epic on load
  useEffect(() => {
    if (selectedEpic === null && epicNames.length > 0) setSelectedEpic(epicNames[0]!);
  }, [epicNames.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentEpicTasks = useMemo(
    () => (selectedEpic ? (epicMap.get(selectedEpic) ?? []) : []),
    [selectedEpic, epicMap],
  );

  // Build sprint map for selected epic
  const sprintMap = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of currentEpicTasks) {
      const s = t.sprint ?? "No Sprint";
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push(t);
    }
    return map;
  }, [currentEpicTasks]);

  const sprintNames = useMemo(
    () =>
      [...sprintMap.keys()].sort((a, b) => {
        if (a === "No Sprint") return 1;
        if (b === "No Sprint") return -1;
        return naturalSort(a, b);
      }),
    [sprintMap],
  );

  async function runScope(type: "epic" | "sprint", name: string) {
    const key = `${type}:${name}`;
    setLoadingKey(key);
    setBlockersMap((prev) => { const next = new Map(prev); next.delete(key); return next; });
    try {
      const result = await api.boards.runScope(boardId, type, name);
      if (result.blockers.length > 0) {
        setBlockersMap((prev) => new Map(prev).set(key, result.blockers));
      } else if (result.scheduledCount > 0) {
        onRunning();
      }
    } catch {
      // network error — nothing to show
    } finally {
      setLoadingKey(null);
    }
  }

  function clearBlockers(key: string) {
    setBlockersMap((prev) => { const next = new Map(prev); next.delete(key); return next; });
  }

  // ── Empty state ──
  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        No tasks yet — generate a plan or create tasks with Epic / Sprint set
      </div>
    );
  }

  // ── Stats for selected epic ──
  const epicDone = currentEpicTasks.filter((t) => t.status === "done").length;
  const epicInProgress = currentEpicTasks.filter((t) => t.status === "in_progress").length;
  const epicBlocked = currentEpicTasks.filter((t) => t.status === "blocked").length;
  const epicInReview = currentEpicTasks.filter((t) => t.status === "in_review").length;
  const epicIsRunning = epicInProgress > 0;
  const epicKey = `epic:${selectedEpic}`;

  return (
    <div className="h-full flex overflow-hidden">
      {/* ── Left sidebar ── */}
      <div className="w-52 shrink-0 border-r border-slate-800 overflow-y-auto flex flex-col bg-slate-950/40">
        <div className="px-4 py-2.5 border-b border-slate-800 shrink-0">
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Epics</p>
        </div>
        {epicNames.map((epic) => (
          <EpicSidebarItem
            key={epic}
            epic={epic}
            tasks={epicMap.get(epic)!}
            active={selectedEpic === epic}
            onClick={() => setSelectedEpic(epic)}
          />
        ))}
      </div>

      {/* ── Right panel ── */}
      <div className="flex-1 overflow-y-auto min-w-0">
        {!selectedEpic ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">
            Select an epic
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Epic header bar */}
            <div className={`shrink-0 px-6 py-4 border-b border-slate-800 transition-colors ${epicIsRunning ? "bg-amber-950/15" : "bg-slate-900/60"}`}>
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5">
                    {epicIsRunning && <Spinner size="sm" />}
                    <h2 className={`text-lg font-bold truncate ${epicIsRunning ? "text-amber-100" : "text-slate-100"}`}>{selectedEpic}</h2>
                  </div>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-xs text-slate-500">{currentEpicTasks.length} tasks</span>
                    {epicInProgress > 0 && (
                      <span className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
                        <span className="w-3 h-3 rounded-full border border-amber-400/30 border-t-amber-400 animate-spin" />
                        {epicInProgress} running
                      </span>
                    )}
                    {epicInReview > 0 && (
                      <span className="text-xs text-purple-400">{epicInReview} in review</span>
                    )}
                    {epicBlocked > 0 && (
                      <span className="text-xs text-red-400">{epicBlocked} blocked</span>
                    )}
                    {epicDone > 0 && (
                      <span className="text-xs text-emerald-400 flex items-center gap-1">
                        <Check size={11} /> {epicDone} done
                      </span>
                    )}
                  </div>
                  <div className="mt-2.5 max-w-xs">
                    <ProgressBar done={epicDone} total={currentEpicTasks.length} />
                  </div>
                </div>

                <RunButton
                  label="Run Epic"
                  loading={loadingKey === epicKey}
                  disabled={epicIsRunning}
                  runningCount={epicInProgress}
                  onClick={() => runScope("epic", selectedEpic!)}
                />
              </div>

              {/* Epic-level blocker alert */}
              {blockersMap.get(epicKey)?.length ? (
                <div className="mt-3">
                  <BlockerAlert
                    blockers={blockersMap.get(epicKey)!}
                    onDismiss={() => clearBlockers(epicKey)}
                  />
                </div>
              ) : null}
            </div>

            {/* Sprint cards */}
            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
              {sprintNames.length === 0 ? (
                <div className="flex items-center justify-center py-16 text-slate-600 text-sm">
                  No sprints defined for this epic
                </div>
              ) : (
                sprintNames.map((sprint) => {
                  const sprintKey = `sprint:${sprint}`;
                  return (
                    <SprintCard
                      key={sprint}
                      sprint={sprint}
                      tasks={sprintMap.get(sprint)!}
                      loading={loadingKey === sprintKey}
                      blockers={blockersMap.get(sprintKey) ?? []}
                      onRun={() => runScope("sprint", sprint)}
                      onTaskClick={onTaskClick}
                      onDismissBlockers={() => clearBlockers(sprintKey)}
                    />
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
