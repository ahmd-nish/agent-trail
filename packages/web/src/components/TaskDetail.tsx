import { useState, useEffect } from "react";
import { Play, Check, X, AlertTriangle, Square } from "lucide-react";
import type { Task } from "../../../core/src/types/index.ts";
import { api } from "../lib/api.ts";
import { DecisionTicket } from "./DecisionTicket.tsx";
import { StatusBadge, ArtifactViewer, ActivityLine } from "./task-detail/atoms.tsx";
import { RunningModeBody } from "./task-detail/RunningMode.tsx";
import { ReviewModeBody } from "./task-detail/ReviewMode.tsx";
import { MetadataPanel } from "./task-detail/MetadataPanel.tsx";
import { CriteriaPanel } from "./task-detail/CriteriaPanel.tsx";
import { useTaskExecution } from "./task-detail/useTaskExecution.ts";

interface Props {
  task: Task | null;
  boardTasks?: Task[];
  onClose: () => void;
  onUpdated: (task: Task) => void;
  onDeleted: (taskId: string) => void;
}

export function TaskDetail({ task, boardTasks = [], onClose, onUpdated, onDeleted }: Props) {
  const [form, setForm] = useState<Partial<Task>>({});
  const [saving, setSaving] = useState(false);
  const [reviewTab, setReviewTab] = useState<"review" | "edit">("review");

  const { running, activity, tickets, artifacts, executions, activityRef, runTask, stopTask, resumeAfterDecision } = useTaskExecution(task, onUpdated);
  const [stopping, setStopping] = useState(false);

  useEffect(() => { if (task?.status !== "in_progress") setStopping(false); }, [task?.status]);

  async function handleStop() {
    if (stopping) return;
    setStopping(true);
    try { await stopTask(); } catch { setStopping(false); }
  }

  useEffect(() => {
    if (!task) return;
    setForm({ ...task });
    setReviewTab("review");
  }, [task?.id, task?.status]);

  if (!task) return null;

  async function save(patch: Partial<Task>) {
    if (!task) return;
    setSaving(true);
    try {
      const updated = await api.tasks.update(task.id, patch);
      onUpdated(updated);
      setForm((prev) => ({ ...prev, ...patch }));
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    if (!task || !confirm("delete this task?")) return;
    await api.tasks.delete(task.id);
    onDeleted(task.id);
    onClose();
  }

  const isRunningMode = task.status === "in_progress";
  const isReview = task.status === "in_review" || task.status === "done";
  const hasBottomContent = activity.length > 0 || tickets.length > 0 || artifacts.length > 0;

  const borderColor = isRunningMode ? "var(--green-line)"
    : task.status === "blocked" ? "rgba(255,107,107,0.3)"
    : task.status === "in_review" ? "rgba(192,137,233,0.3)"
    : task.status === "done" ? "rgba(94,232,157,0.2)"
    : "var(--line)";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.75)" }} onClick={onClose} />

      <div
        className={`relative z-10 w-full flex flex-col overflow-hidden ${
          isRunningMode ? "max-w-4xl" : isReview ? "max-w-6xl" : "max-w-5xl"
        }`}
        style={{
          maxHeight: "92vh",
          background: "var(--bg-pane)",
          border: `1px solid ${borderColor}`,
          borderRadius: 4,
          ...(isRunningMode ? { boxShadow: "0 0 24px rgba(94,232,157,0.08)" } : {}),
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{
            borderBottom: `1px solid ${isRunningMode ? "var(--green-line)" : "var(--line)"}`,
            background: isRunningMode ? "rgba(94,232,157,0.04)" : "transparent",
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            {isRunningMode && (
              <span
                className="w-3.5 h-3.5 rounded-full border-2 animate-spin shrink-0"
                style={{ borderColor: "var(--green-line)", borderTopColor: "var(--green)" }}
              />
            )}
            <h2
              className="font-medium text-sm truncate"
              style={{ color: isRunningMode ? "var(--green)" : "var(--fg)" }}
            >
              {task.title}
            </h2>
            <StatusBadge status={task.status} />
            {[task.epic, task.sprint].filter(Boolean).length > 0 && (
              <span className="text-[10px] truncate hidden sm:block" style={{ color: "var(--fg-faded)" }}>
                {[task.epic, task.sprint].filter(Boolean).join(" · ")}
              </span>
            )}
            {saving && <span style={{ fontSize: 10, color: "var(--fg-faded)" }}>saving…</span>}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isReview && (
              <div
                className="flex mr-1"
                style={{ border: "1px solid var(--line)", borderRadius: 2, overflow: "hidden" }}
              >
                {(["review", "edit"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setReviewTab(t)}
                    className="text-[10px] px-3 py-1 transition-colors"
                    style={{
                      fontFamily: "inherit",
                      background: reviewTab === t ? "var(--bg-panel)" : "transparent",
                      color: reviewTab === t ? "var(--fg)" : "var(--fg-faded)",
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}

            {!isReview && !isRunningMode && (
              <button onClick={runTask} disabled={running} className="claw-btn primary" style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}>
                <Play size={10} /> run
              </button>
            )}
            {isRunningMode && (
              <button
                onClick={handleStop}
                disabled={stopping}
                title="sends SIGTERM, then SIGKILL after 3s"
                className="claw-btn"
                style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4, borderColor: "rgba(255,107,107,0.35)", color: "var(--red)" }}
              >
                <Square size={10} /> {stopping ? "stopping…" : "stop"}
              </button>
            )}
            {isReview && (
              <button
                onClick={() => save({ status: "done" })}
                disabled={task.status === "done" || saving}
                className="claw-btn"
                style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4, borderColor: "rgba(94,232,157,0.3)", color: "var(--green)" }}
              >
                <Check size={10} /> {task.status === "done" ? "done" : "mark done"}
              </button>
            )}
            <button
              onClick={del}
              className="text-[10px] px-2 py-1 rounded transition-colors"
              style={{ color: "var(--red)", fontFamily: "inherit" }}
            >
              delete
            </button>
            <button onClick={onClose} style={{ color: "var(--fg-faded)", display: "flex" }}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Failure banner */}
        {task.status === "blocked" && task.lastError && tickets.length === 0 && (
          <div
            className="shrink-0 px-5 py-2.5 flex items-start gap-3"
            style={{ background: "var(--red-dim)", borderBottom: "1px solid rgba(255,107,107,0.3)" }}
          >
            <AlertTriangle size={12} style={{ color: "var(--red)", flexShrink: 0, marginTop: 1 }} />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-medium mb-0.5" style={{ color: "var(--red)" }}>last run failed</p>
              <p className="text-[11px] whitespace-pre-wrap break-words" style={{ color: "var(--fg-dim)" }}>{task.lastError}</p>
            </div>
          </div>
        )}

        {/* Running mode */}
        {isRunningMode && <RunningModeBody task={task} activity={activity} />}

        {/* Review mode */}
        {!isRunningMode && isReview && reviewTab === "review" && (
          <ReviewModeBody
            task={task}
            executions={executions}
            artifacts={artifacts}
            successCriteria={task.successCriteria}
            onStatusChange={(s) => save({ status: s })}
            onRerun={async (fixNote) => {
              const existingPrompt = task.additionalPrompt ?? "";
              const newPrompt = existingPrompt ? `${existingPrompt}\n\n--- Fix requested ---\n${fixNote}` : `Fix needed: ${fixNote}`;
              await save({ additionalPrompt: newPrompt, status: "ready" });
              await runTask();
              setReviewTab("edit");
            }}
          />
        )}

        {/* Edit / normal body */}
        {!isRunningMode && (!isReview || reviewTab === "edit") && (
          <div className="flex-1 overflow-hidden min-h-0 flex">
            <MetadataPanel task={task} form={form} setForm={setForm} save={save} boardTasks={boardTasks} />

            <div className="flex-1 overflow-y-auto flex flex-col gap-4 p-5">
              <CriteriaPanel task={task} form={form} setForm={setForm} save={save} />

              {hasBottomContent && (
                <div className="flex flex-col gap-4 pt-4" style={{ borderTop: "1px solid var(--line-dim)" }}>
                  {tickets.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--fg-faded)", letterSpacing: "0.05em" }}>
                        // awaiting decision
                      </span>
                      {tickets.map((t) => (
                        <DecisionTicket key={t.id} ticket={t} onAnswered={(ticketId, answer) => resumeAfterDecision(ticketId, answer)} />
                      ))}
                    </div>
                  )}

                  {activity.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--fg-faded)", letterSpacing: "0.05em" }}>
                        // activity
                      </span>
                      <div
                        ref={activityRef}
                        className="p-2 max-h-40 overflow-y-auto flex flex-col gap-0.5"
                        style={{ background: "var(--bg)", border: "1px solid var(--line-dim)", borderRadius: 2 }}
                      >
                        {activity.map((e, i) => <ActivityLine key={i} event={e} />)}
                      </div>
                    </div>
                  )}

                  {artifacts.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--fg-faded)", letterSpacing: "0.05em" }}>
                        // artifacts
                      </span>
                      {artifacts.map((a) => <ArtifactViewer key={a.id} artifact={a} />)}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
