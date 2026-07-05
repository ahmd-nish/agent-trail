import { useState, useEffect } from "react";
import { api, type TaskMetricsRow } from "../lib/api.ts";

interface Props {
  boardId: string;
}

function fmtDuration(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function fmtTokens(n: number): string {
  if (n === 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-slate-900 border border-slate-700/60 rounded-xl px-5 py-4">
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-slate-100 mt-1">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

type GroupRow = {
  name: string;
  tasks: number;
  done: number;
  inProgress: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
};

function GroupTable({ title, rows }: { title: string; rows: GroupRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="bg-slate-900 border border-slate-700/60 rounded-xl overflow-hidden">
      <p className="px-5 py-3 text-sm font-semibold text-slate-300 border-b border-slate-700/60">{title}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500 border-b border-slate-700/40">
            <th className="text-left px-5 py-2 font-medium">Name</th>
            <th className="text-right px-4 py-2 font-medium">Tasks</th>
            <th className="text-right px-4 py-2 font-medium">Done</th>
            <th className="text-right px-4 py-2 font-medium">Active</th>
            <th className="text-right px-4 py-2 font-medium">Time</th>
            <th className="text-right px-5 py-2 font-medium">Tokens (in/out)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = r.tasks === 0 ? 0 : Math.round((r.done / r.tasks) * 100);
            return (
              <tr key={r.name} className="border-b border-slate-700/20 hover:bg-slate-800/40 transition-colors">
                <td className="px-5 py-2.5 text-slate-200 font-medium">{r.name}</td>
                <td className="px-4 py-2.5 text-right text-slate-400">{r.tasks}</td>
                <td className="px-4 py-2.5 text-right">
                  <span className="text-emerald-400">{r.done}</span>
                  <span className="text-slate-600"> / {pct}%</span>
                </td>
                <td className="px-4 py-2.5 text-right text-amber-400">{r.inProgress}</td>
                <td className="px-4 py-2.5 text-right text-slate-300">{fmtDuration(r.durationMs)}</td>
                <td className="px-5 py-2.5 text-right text-slate-400">
                  <span className="text-blue-400">{fmtTokens(r.inputTokens)}</span>
                  <span className="text-slate-600"> / </span>
                  <span className="text-violet-400">{fmtTokens(r.outputTokens)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  backlog: "text-slate-400",
  ready: "text-blue-400",
  in_progress: "text-amber-400",
  blocked: "text-red-400",
  in_review: "text-purple-400",
  done: "text-emerald-400",
};

function TaskTable({ rows }: { rows: TaskMetricsRow[] }) {
  const [sort, setSort] = useState<"time" | "tokens" | "status">("status");
  const sorted = [...rows].sort((a, b) => {
    if (sort === "time") return b.total_duration_ms - a.total_duration_ms;
    if (sort === "tokens") return (b.total_input_tokens + b.total_output_tokens) - (a.total_input_tokens + a.total_output_tokens);
    // by status order
    const order = ["in_progress", "blocked", "in_review", "ready", "done", "backlog"];
    return order.indexOf(a.status) - order.indexOf(b.status);
  });

  return (
    <div className="bg-slate-900 border border-slate-700/60 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/60">
        <p className="text-sm font-semibold text-slate-300">Tasks</p>
        <div className="flex gap-1">
          {(["status", "time", "tokens"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={`text-[10px] px-2 py-0.5 rounded ${sort === s ? "bg-slate-700 text-slate-200" : "text-slate-500 hover:text-slate-300"}`}
            >
              {s === "status" ? "By status" : s === "time" ? "By time" : "By tokens"}
            </button>
          ))}
        </div>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500 border-b border-slate-700/40">
            <th className="text-left px-5 py-2 font-medium">Task</th>
            <th className="text-left px-3 py-2 font-medium hidden md:table-cell">Epic / Sprint</th>
            <th className="text-right px-4 py-2 font-medium">Status</th>
            <th className="text-right px-4 py-2 font-medium">Runs</th>
            <th className="text-right px-4 py-2 font-medium">Time</th>
            <th className="text-right px-5 py-2 font-medium">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.task_id} className="border-b border-slate-700/20 hover:bg-slate-800/40 transition-colors">
              <td className="px-5 py-2 text-slate-200 max-w-[220px]">
                <span className="truncate block">{r.title}</span>
              </td>
              <td className="px-3 py-2 hidden md:table-cell">
                <span className="text-slate-500">{r.epic ?? "—"}</span>
                {r.sprint && <span className="text-slate-600"> / {r.sprint}</span>}
              </td>
              <td className="px-4 py-2 text-right">
                <span className={`font-medium ${STATUS_COLORS[r.status] ?? "text-slate-400"}`}>
                  {r.status.replace("_", " ")}
                </span>
              </td>
              <td className="px-4 py-2 text-right text-slate-400">{r.execution_count || "—"}</td>
              <td className="px-4 py-2 text-right text-slate-300">{fmtDuration(r.total_duration_ms)}</td>
              <td className="px-5 py-2 text-right">
                {r.total_input_tokens + r.total_output_tokens === 0 ? (
                  <span className="text-slate-600">—</span>
                ) : (
                  <span className="text-violet-400">{fmtTokens(r.total_input_tokens + r.total_output_tokens)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardView({ boardId }: Props) {
  const [metrics, setMetrics] = useState<TaskMetricsRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.metrics.board(boardId).then(setMetrics).finally(() => setLoading(false));
  }, [boardId]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-slate-500 text-sm">Loading metrics…</div>;
  }
  if (!metrics || metrics.length === 0) {
    return <div className="flex items-center justify-center h-full text-slate-500 text-sm">No task data yet</div>;
  }

  const totalTasks = metrics.length;
  const done = metrics.filter((r) => r.status === "done").length;
  const totalMs = metrics.reduce((s, r) => s + r.total_duration_ms, 0);
  const totalIn = metrics.reduce((s, r) => s + r.total_input_tokens, 0);
  const totalOut = metrics.reduce((s, r) => s + r.total_output_tokens, 0);

  // Group by epic
  const epicMap = new Map<string, TaskMetricsRow[]>();
  for (const r of metrics) {
    const e = r.epic ?? "No Epic";
    if (!epicMap.has(e)) epicMap.set(e, []);
    epicMap.get(e)!.push(r);
  }
  const epicRows: GroupRow[] = [...epicMap.entries()].map(([name, rows]) => ({
    name,
    tasks: rows.length,
    done: rows.filter((r) => r.status === "done").length,
    inProgress: rows.filter((r) => r.status === "in_progress").length,
    durationMs: rows.reduce((s, r) => s + r.total_duration_ms, 0),
    inputTokens: rows.reduce((s, r) => s + r.total_input_tokens, 0),
    outputTokens: rows.reduce((s, r) => s + r.total_output_tokens, 0),
  })).sort((a, b) => a.name === "No Epic" ? 1 : b.name === "No Epic" ? -1 : a.name.localeCompare(b.name));

  // Group by sprint
  const sprintMap = new Map<string, TaskMetricsRow[]>();
  for (const r of metrics) {
    const s = r.sprint ?? "No Sprint";
    if (!sprintMap.has(s)) sprintMap.set(s, []);
    sprintMap.get(s)!.push(r);
  }
  const sprintRows: GroupRow[] = [...sprintMap.entries()].map(([name, rows]) => ({
    name,
    tasks: rows.length,
    done: rows.filter((r) => r.status === "done").length,
    inProgress: rows.filter((r) => r.status === "in_progress").length,
    durationMs: rows.reduce((s, r) => s + r.total_duration_ms, 0),
    inputTokens: rows.reduce((s, r) => s + r.total_input_tokens, 0),
    outputTokens: rows.reduce((s, r) => s + r.total_output_tokens, 0),
  })).sort((a, b) => a.name === "No Sprint" ? 1 : b.name === "No Sprint" ? -1 : a.name.localeCompare(b.name));

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto flex flex-col gap-5 p-2">
        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryCard
            label="Completion"
            value={`${totalTasks === 0 ? 0 : Math.round((done / totalTasks) * 100)}%`}
            sub={`${done} / ${totalTasks} tasks done`}
          />
          <SummaryCard
            label="Total time"
            value={fmtDuration(totalMs)}
            sub="across all executions"
          />
          <SummaryCard
            label="Input tokens"
            value={fmtTokens(totalIn)}
            sub="consumed by agents"
          />
          <SummaryCard
            label="Output tokens"
            value={fmtTokens(totalOut)}
            sub="generated by agents"
          />
        </div>

        <GroupTable title="By Epic" rows={epicRows} />
        <GroupTable title="By Sprint" rows={sprintRows} />
        <TaskTable rows={metrics} />
      </div>
    </div>
  );
}
