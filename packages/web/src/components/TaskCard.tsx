import { useState, useEffect, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FlaskConical } from "lucide-react";
import type { Task } from "../../../core/src/types/index.ts";
import { streamTaskEvents } from "../lib/api.ts";

function useElapsed(startIso: string | null): string {
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    if (!startIso) return;
    const start = new Date(startIso).getTime();
    const tick = () => {
      const s = Math.floor((Date.now() - start) / 1000);
      if (s < 60) setElapsed(`${s}s`);
      else { const m = Math.floor(s / 60); setElapsed(`${m}m ${s % 60}s`); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startIso]);

  return elapsed;
}

interface Props {
  task: Task;
  onClick: (task: Task) => void;
}

export function TaskCard({ task, onClick }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });

  // Engagement beat: brief pulse when this task transitions to done.
  const [donePulse, setDonePulse] = useState(false);
  const prevStatus = useRef(task.status);
  useEffect(() => {
    if (prevStatus.current !== "done" && task.status === "done") {
      setDonePulse(true);
      const t = setTimeout(() => setDonePulse(false), 900);
      return () => clearTimeout(t);
    }
    prevStatus.current = task.status;
  }, [task.status]);

  // Engagement beat: red→green flash whenever a test_result event arrives
  // via SSE (or demo replay). Only listens while task is in progress to keep
  // the fan-out bounded.
  const [testFlash, setTestFlash] = useState<"pass" | "fail" | null>(null);
  useEffect(() => {
    if (task.status !== "in_progress") return;
    const unsub = streamTaskEvents(task.id, (ev) => {
      if (ev.type !== "test_result") return;
      setTestFlash(ev.passed ? "pass" : "fail");
      setTimeout(() => setTestFlash(null), 700);
    });
    return () => unsub();
  }, [task.id, task.status]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.2 : 1,
  };

  const isRunning  = task.status === "in_progress";
  const isAwaiting = task.status === "blocked" && !!task.activeForm;
  const isBlocked  = task.status === "blocked" && !task.activeForm;
  const isDone     = task.status === "done";
  const isReview   = task.status === "in_review";

  const elapsed = useElapsed(isRunning ? task.updatedAt : null);

  let borderColor = "var(--line)";
  let extraClasses = "card-tilt";
  if (isRunning)  { borderColor = "var(--green-line)"; extraClasses += " card-running-glow card-scan-sweep"; }
  if (isAwaiting) { borderColor = "rgba(255,180,84,0.35)"; extraClasses += " card-awaiting-glow"; }
  if (isBlocked)  { borderColor = "rgba(255,107,107,0.3)"; }
  if (isReview)   { borderColor = "rgba(192,137,233,0.3)"; }
  if (isDone)     { borderColor = "rgba(94,232,157,0.15)"; }
  if (donePulse) extraClasses += " card-done-pulse";
  if (testFlash === "pass") extraClasses += " card-flash-green";
  if (testFlash === "fail") extraClasses += " card-flash-red";

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, background: "var(--bg-pane)", border: `1px solid ${borderColor}` }}
      {...attributes}
      {...listeners}
      onClick={() => onClick(task)}
      className={`relative overflow-hidden rounded cursor-pointer select-none ${extraClasses}`}
    >
      {/* Left-edge accent bar */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[2px]"
        style={{
          background: isRunning  ? "var(--green)"
                    : isAwaiting ? "var(--amber)"
                    : isBlocked  ? "var(--red)"
                    : isReview   ? "var(--purple)"
                    : isDone     ? "rgba(94,232,157,0.4)"
                    : "var(--line)",
        }}
      />

      <div className="pl-3 pr-2.5 py-2.5 flex flex-col gap-1.5">
        {/* Title row */}
        <div className="flex items-start justify-between gap-1">
          <p
            className="text-xs font-medium leading-snug flex-1"
            style={{
              color: isDone     ? "var(--fg-faded)"
                   : isRunning  ? "var(--green)"
                   : isAwaiting ? "var(--amber)"
                   : "var(--fg)",
              textDecoration: isDone ? "line-through" : undefined,
            }}
          >
            {task.title}
          </p>
          {/* Live elapsed timer */}
          {isRunning && elapsed && (
            <span
              className="text-[9px] tabular-nums shrink-0 mt-0.5"
              style={{ color: "var(--green)", opacity: 0.7 }}
            >
              {elapsed}
            </span>
          )}
        </div>

        {/* Chips row */}
        <div className="flex items-center gap-1 flex-wrap">
          {isRunning && (
            <span className="claw-chip green" style={{ gap: 3 }}>
              <span className="w-1 h-1 rounded-full col-active-dot shrink-0" style={{ background: "var(--green)" }} />
              live
            </span>
          )}
          {isAwaiting && (
            <span className="claw-chip amber" style={{ gap: 3 }}>
              <span className="w-1 h-1 rounded-full col-active-dot shrink-0" style={{ background: "var(--amber)" }} />
              needs you
            </span>
          )}
          {isBlocked && <span className="claw-chip red">blocked</span>}
          {isReview   && <span className="claw-chip purple">review</span>}
          {isDone     && <span className="claw-chip green" style={{ opacity: 0.6 }}>done</span>}

          {!isRunning && !isAwaiting && !isBlocked && !isDone && !isReview && (
            <span
              className="claw-chip"
              style={{
                color: task.priority === "critical" ? "var(--red)"
                     : task.priority === "high"     ? "var(--amber)"
                     : task.priority === "medium"   ? "var(--blue)"
                     : "var(--fg-faded)",
              }}
            >
              {task.priority}
            </span>
          )}

          {task.tddEnabled && (
            <span className="claw-chip cyan" style={{ gap: 3 }}>
              <FlaskConical size={8} /> tdd
            </span>
          )}
          {task.epic && (
            <span className="claw-chip purple" style={{ maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={task.epic}>
              {task.epic}
            </span>
          )}
          {task.modelTier && (
            <span
              className="claw-chip"
              title={`model tier — ${task.modelTier}`}
              style={{
                color: task.modelTier === "opus" ? "var(--purple)"
                     : task.modelTier === "haiku" ? "var(--fg-faded)"
                     : "var(--blue)",
              }}
            >
              {task.modelTier}
            </span>
          )}
        </div>

        {/* Error preview */}
        {isBlocked && task.lastError && (
          <p className="text-[10px] leading-relaxed truncate" style={{ color: "var(--red)", opacity: 0.7 }}>
            {task.lastError.split("\n")[0]}
          </p>
        )}
      </div>
    </div>
  );
}
