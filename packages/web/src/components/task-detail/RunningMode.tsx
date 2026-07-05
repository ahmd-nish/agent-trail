import { useState, useEffect, useMemo } from "react";
import { MessageSquare, Sparkles } from "lucide-react";
import type { Task } from "../../../../core/src/types/index.ts";
import type { UiEvent } from "../../lib/api.ts";
import { toolStyle } from "./atoms.tsx";
import { BeatFeed } from "../beat-feed/BeatFeed.tsx";

interface Props {
  task: Task;
  activity: UiEvent[];
}

/** Rotating playful status messages — used when the agent is between tool calls. */
const FUN_STATUSES = [
  "Thinking it through…",
  "Cooking up some code…",
  "Connecting the dots…",
  "Wiring things together…",
  "Making it real…",
  "Sharpening the pencils…",
  "Reading the room…",
  "Plotting the next move…",
  "Aligning the bits and bytes…",
  "Drawing inspiration from the docs…",
];

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${rest}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function RunningModeBody({ task, activity }: Props) {
  // ── Live elapsed counter (ticks every second while open)
  const startedAt = useMemo(() => Date.parse(task.updatedAt), [task.updatedAt]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedMs = Math.max(0, now - startedAt);

  // ── Rotating fun status (changes every 6s)
  const [statusIdx, setStatusIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStatusIdx((i) => (i + 1) % FUN_STATUSES.length), 6000);
    return () => clearInterval(id);
  }, []);

  // ── Derived from activity
  const lastTool = [...activity].reverse().find((e) => e.type === "tool_call");
  const lastText = [...activity].reverse().find((e) => e.type === "text");
  const toolCalls = activity.filter((e) => e.type === "tool_call");
  const toolCallCount = toolCalls.length;
  const errorCount = activity.filter((e) => e.type === "tool_result" && e.isError).length;

  // Build per-tool tally so we can render activity chips like 🐚×12 📖×5 …
  const toolTally = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of toolCalls) {
      if (e.type !== "tool_call") continue;
      counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [activity.length]);

  // Headline derives from the latest tool call OR a fun rotating phrase.
  const headlineActivity = lastTool?.type === "tool_call" ? lastTool.tool : null;
  const headlineStyle = headlineActivity ? toolStyle(headlineActivity) : null;

  return (
    <div className="flex-1 overflow-hidden min-h-0 flex flex-col">

      {/* ─── Hero header ─── */}
      <div className="shrink-0 px-6 py-3 border-b border-amber-800/30 bg-gradient-to-r from-amber-950/30 via-amber-950/10 to-orange-950/20 flex flex-col gap-2">

        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-2xl flex items-center justify-center w-8 h-8">
            {headlineStyle
              ? <headlineStyle.Icon size={22} className={headlineStyle.color} />
              : <Sparkles size={22} className="text-amber-400" />}
          </span>
          <div className="flex-1 min-w-0">
            {headlineActivity ? (
              <p className="text-sm font-semibold text-amber-100">
                Claude is using <span className="font-mono shimmer-text">{headlineActivity}</span>…
              </p>
            ) : (
              <p className="text-sm font-semibold shimmer-text">
                {FUN_STATUSES[statusIdx]}
              </p>
            )}
            {lastText?.type === "text" && (
              <p className="text-[10px] text-amber-300/60 italic truncate mt-0.5 flex items-center gap-1" title={lastText.text}>
                <MessageSquare size={10} className="shrink-0" />
                {lastText.text}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-[10px] uppercase tracking-widest text-amber-400 font-bold">Live</span>
          </div>
        </div>

        {/* Stat strip */}
        <div className="flex items-center gap-4 flex-wrap text-[10px] text-amber-300/70">
          <div className="flex items-center gap-1.5">
            <span className="text-amber-200/40 uppercase tracking-wider font-semibold">Agent</span>
            <span className="text-amber-200 font-mono">{task.assignee}</span>
          </div>
          {task.component && (
            <div className="flex items-center gap-1.5">
              <span className="text-amber-200/40 uppercase tracking-wider font-semibold">Component</span>
              <span className="text-amber-200 font-mono truncate max-w-[260px]">{task.component}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-amber-200/40 uppercase tracking-wider font-semibold">Elapsed</span>
            <span className="text-amber-200 tabular-nums">{fmtElapsed(elapsedMs)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-amber-200/40 uppercase tracking-wider font-semibold">Steps</span>
            <span className="text-amber-200 tabular-nums">{toolCallCount}</span>
          </div>
          {errorCount > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-red-300/60 uppercase tracking-wider font-semibold">Errors</span>
              <span className="text-red-300 tabular-nums">{errorCount}</span>
            </div>
          )}
        </div>

        {/* Per-tool tally chips */}
        {toolTally.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
            {toolTally.slice(0, 8).map(([tool, count]) => {
              const s = toolStyle(tool);
              return (
                <span
                  key={tool}
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${s.bg} ${s.color} flex items-center gap-1 font-mono`}
                  title={`${count} call${count === 1 ? "" : "s"} to ${tool}`}
                >
                  <s.Icon size={10} />
                  <span>{tool}</span>
                  <span className="text-slate-500">×{count}</span>
                </span>
              );
            })}
            {toolTally.length > 8 && (
              <span className="text-[10px] text-slate-500">+{toolTally.length - 8} more</span>
            )}
          </div>
        )}
      </div>

      {/* ─── Activity stream ─── */}
      <BeatFeed
        events={activity}
        isRunning
        className="flex-1"
      />

      {/* ─── Task footer ─── */}
      <div className="shrink-0 border-t border-slate-800 px-6 py-3 bg-slate-900/60 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold">Task</span>
          <span className="text-[10px] text-slate-600">·</span>
          <span className="text-[10px] text-slate-500">{task.title}</span>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">{task.description || "No description."}</p>
        {task.successCriteria.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mt-0.5">
            {task.successCriteria.map((c, i) => (
              <span key={i} className="text-[10px] text-slate-500 bg-slate-800 rounded px-1.5 py-0.5 truncate max-w-[220px]" title={c}>
                ✓ {c}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
