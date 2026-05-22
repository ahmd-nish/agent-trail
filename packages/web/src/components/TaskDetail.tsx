import { useState, useEffect, useRef } from "react";
import type { Task, TaskStatus, Priority, AgentKind } from "../../../core/src/types/index.ts";
import { api, streamTaskEvents, type UiEvent, type DecisionTicketRow, type ArtifactRow } from "../lib/api.ts";
import { DecisionTicket } from "./DecisionTicket.tsx";

interface Props {
  task: Task | null;
  onClose: () => void;
  onUpdated: (task: Task) => void;
  onDeleted: (taskId: string) => void;
}

const STATUSES: TaskStatus[] = ["backlog", "ready", "in_progress", "blocked", "in_review", "done"];
const PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];
const AGENTS: AgentKind[] = ["claude-code", "codex", "gemini", "custom"];

export function TaskDetail({ task, onClose, onUpdated, onDeleted }: Props) {
  const [form, setForm] = useState<Partial<Task>>({});
  const [saving, setSaving] = useState(false);
  const [mcpInput, setMcpInput] = useState("");
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState<UiEvent[]>([]);
  const [tickets, setTickets] = useState<DecisionTicketRow[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const activityRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (task) {
      setForm({ ...task });
      setActivity([]);
      setRunning(task.status === "in_progress");
      if (task.status === "blocked") {
        api.tasks.decisions(task.id).then(setTickets).catch(() => undefined);
      } else {
        setTickets([]);
      }
      api.artifacts.list(task.id).then(setArtifacts).catch(() => undefined);
    }
  }, [task?.id, task?.status]);

  // Auto-scroll activity feed
  useEffect(() => {
    if (activityRef.current) {
      activityRef.current.scrollTop = activityRef.current.scrollHeight;
    }
  }, [activity]);

  async function runTask() {
    if (!task || running) return;
    setRunning(true);
    setActivity([]);
    try {
      await api.tasks.execute(task.id);
      const stop = streamTaskEvents(task.id, (e) => {
        setActivity((a) => [...a, e]);
        if (e.type === "execution_complete" || e.type === "awaiting_human") {
          setRunning(false);
          stop();
          api.tasks.list(task.boardId).then((tasks) => {
            const updated = tasks.find((t) => t.id === task.id);
            if (updated) onUpdated(updated);
          }).catch(() => undefined);
          if (e.type === "awaiting_human") {
            api.tasks.decisions(task.id).then(setTickets).catch(() => undefined);
          }
          if (e.type === "execution_complete") {
            api.artifacts.list(task.id).then(setArtifacts).catch(() => undefined);
          }
        }
      });
    } catch (err) {
      setRunning(false);
      setActivity([{ type: "execution_complete", status: "failed", executionId: "" }]);
    }
  }

  if (!task) return null;

  const field = <K extends keyof Task>(key: K) => (form[key] as Task[K]) ?? task[key];

  async function save(patch: Partial<Task>) {
    if (!task) return;
    setSaving(true);
    try {
      const updated = await api.tasks.update(task.id, patch);
      onUpdated(updated);
      setForm((f) => ({ ...f, ...patch }));
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    if (!task || !confirm("Delete this task?")) return;
    await api.tasks.delete(task.id);
    onDeleted(task.id);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Overlay */}
      <div className="flex-1 bg-black/40" onClick={onClose} />
      {/* Panel */}
      <div className="w-[480px] bg-slate-900 border-l border-slate-700 flex flex-col overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <h2 className="text-slate-100 font-semibold text-base">Task detail</h2>
            {running && (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                running
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={runTask}
              disabled={running}
              className="text-xs px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white"
            >
              {running ? "Running…" : "▶ Run"}
            </button>
            <button
              onClick={del}
              className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-slate-800"
            >
              Delete
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-lg leading-none">
              ×
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-5 px-5 py-5">
          {/* Title */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400 font-medium">Title</span>
            <input
              className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-slate-400"
              value={(form.title as string) ?? task.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              onBlur={() => form.title !== task.title && save({ title: form.title })}
            />
          </label>

          {/* Description */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400 font-medium">Description</span>
            <textarea
              rows={3}
              className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-slate-400 resize-none"
              value={(form.description as string) ?? task.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              onBlur={() => form.description !== task.description && save({ description: form.description })}
            />
          </label>

          {/* Status / Priority / Assignee row */}
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-400 font-medium">Status</span>
              <select
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100 text-xs focus:outline-none"
                value={field("status")}
                onChange={(e) => save({ status: e.target.value as TaskStatus })}
              >
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-400 font-medium">Priority</span>
              <select
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100 text-xs focus:outline-none"
                value={field("priority")}
                onChange={(e) => save({ priority: e.target.value as Priority })}
              >
                {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-400 font-medium">Assignee</span>
              <select
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100 text-xs focus:outline-none"
                value={field("assignee")}
                onChange={(e) => save({ assignee: e.target.value as AgentKind })}
              >
                {AGENTS.map((a) => <option key={a}>{a}</option>)}
              </select>
            </label>
          </div>

          {/* TDD toggle */}
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={(form.tddEnabled as boolean) ?? task.tddEnabled}
              onChange={(e) => save({ tddEnabled: e.target.checked })}
              className="w-4 h-4 accent-emerald-500"
            />
            <span className="text-sm text-slate-300">TDD gate enabled</span>
          </label>

          {/* MCPs */}
          <div className="flex flex-col gap-2">
            <span className="text-xs text-slate-400 font-medium">MCPs</span>
            <div className="flex flex-wrap gap-1.5">
              {((form.mcps as string[]) ?? task.mcps).map((mcp) => (
                <span
                  key={mcp}
                  className="text-xs bg-purple-900 text-purple-300 px-2 py-0.5 rounded flex items-center gap-1"
                >
                  {mcp}
                  <button
                    onClick={() => {
                      const mcps = ((form.mcps as string[]) ?? task.mcps).filter((m) => m !== mcp);
                      save({ mcps });
                    }}
                    className="text-purple-400 hover:text-purple-200 text-sm leading-none"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                placeholder="Add MCP server name…"
                value={mcpInput}
                onChange={(e) => setMcpInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && mcpInput.trim()) {
                    const mcps = [...((form.mcps as string[]) ?? task.mcps), mcpInput.trim()];
                    save({ mcps });
                    setMcpInput("");
                  }
                }}
                className="flex-1 bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-slate-100 text-xs focus:outline-none focus:border-slate-400"
              />
            </div>
          </div>

          {/* Dependencies */}
          {task.dependsOn.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-slate-400 font-medium">Depends on</span>
              <div className="flex flex-wrap gap-1">
                {task.dependsOn.map((id) => (
                  <span key={id} className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded font-mono">
                    {id}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Decision tickets */}
          {tickets.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-slate-400 font-medium">Awaiting decision</span>
              {tickets.map((t) => (
                <DecisionTicket
                  key={t.id}
                  ticket={t}
                  onAnswered={(ticketId, answer) => {
                    setTickets((ts) =>
                      ts.map((x) =>
                        x.id === ticketId ? { ...x, answer, answered_at: new Date().toISOString() } : x,
                      ),
                    );
                    setRunning(true);
                    setActivity([]);
                    // Stream will resume via the new execution
                    const stop = streamTaskEvents(task!.id, (e) => {
                      setActivity((a) => [...a, e]);
                      if (e.type === "execution_complete" || e.type === "awaiting_human") {
                        setRunning(false);
                        stop();
                        api.tasks.list(task!.boardId).then((tasks) => {
                          const updated = tasks.find((x) => x.id === task!.id);
                          if (updated) onUpdated(updated);
                        }).catch(() => undefined);
                        if (e.type === "awaiting_human") {
                          api.tasks.decisions(task!.id).then(setTickets).catch(() => undefined);
                        }
                        if (e.type === "execution_complete") {
                          api.artifacts.list(task!.id).then(setArtifacts).catch(() => undefined);
                        }
                      }
                    });
                  }}
                />
              ))}
            </div>
          )}

          {/* Live activity feed */}
          {activity.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-slate-400 font-medium">Activity</span>
              <div
                ref={activityRef}
                className="bg-slate-950 rounded border border-slate-700 p-2 max-h-48 overflow-y-auto flex flex-col gap-1"
              >
                {activity.map((e, i) => (
                  <ActivityLine key={i} event={e} />
                ))}
              </div>
            </div>
          )}

          {/* Artifacts */}
          {artifacts.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-slate-400 font-medium">Artifacts</span>
              {artifacts.map((a) => (
                <ArtifactViewer key={a.id} artifact={a} />
              ))}
            </div>
          )}

          {saving && <p className="text-xs text-slate-500">Saving…</p>}
        </div>
      </div>
    </div>
  );
}

function ArtifactViewer({ artifact }: { artifact: ArtifactRow }) {
  const [expanded, setExpanded] = useState(false);

  const label: Record<ArtifactRow["kind"], string> = {
    git_diff: "Git diff",
    test_output: "Test output",
    file_list: "Changed files",
    pr_url: "PR",
    custom: "Artifact",
  };

  if (artifact.kind === "pr_url") {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded p-2 text-xs text-slate-300">
        PR: <span className="text-indigo-400">{artifact.content}</span>
      </div>
    );
  }

  if (artifact.kind === "file_list") {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded p-2">
        <p className="text-[11px] text-slate-400 mb-1 font-medium">{label[artifact.kind]}</p>
        <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono">{artifact.content}</pre>
      </div>
    );
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded overflow-hidden">
      <button
        onClick={() => setExpanded((x) => !x)}
        className="w-full text-left px-3 py-2 flex items-center justify-between hover:bg-slate-750"
      >
        <span className="text-[11px] text-slate-400 font-medium">{label[artifact.kind]}</span>
        <span className="text-[10px] text-slate-500">{expanded ? "▲ collapse" : "▼ expand"}</span>
      </button>
      {expanded && (
        <div className="border-t border-slate-700 max-h-64 overflow-y-auto">
          {artifact.kind === "git_diff" ? (
            <DiffViewer content={artifact.content} />
          ) : (
            <pre className="text-[11px] text-slate-300 p-3 font-mono whitespace-pre-wrap">
              {artifact.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function DiffViewer({ content }: { content: string }) {
  return (
    <pre className="text-[11px] font-mono p-3 whitespace-pre-wrap leading-relaxed">
      {content.split("\n").map((line, i) => {
        const color =
          line.startsWith("+") && !line.startsWith("+++") ? "text-emerald-400"
          : line.startsWith("-") && !line.startsWith("---") ? "text-red-400"
          : line.startsWith("@@") ? "text-blue-400"
          : line.startsWith("diff ") || line.startsWith("index ") ? "text-slate-400"
          : "text-slate-300";
        return (
          <span key={i} className={`block ${color}`}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

function ActivityLine({ event }: { event: UiEvent }) {
  if (event.type === "connected") {
    return <p className="text-[11px] text-slate-500">Connected — execution {event.executionId.slice(0, 8)}</p>;
  }
  if (event.type === "tool_call") {
    return (
      <p className="text-[11px] text-purple-400">
        <span className="text-slate-500">→</span> {event.tool}
      </p>
    );
  }
  if (event.type === "tool_result") {
    return (
      <p className={`text-[11px] ${event.isError ? "text-red-400" : "text-slate-500"}`}>
        ← {event.isError ? "error" : "ok"}
      </p>
    );
  }
  if (event.type === "text") {
    return <p className="text-[11px] text-slate-300 leading-relaxed">{event.text}</p>;
  }
  if (event.type === "execution_complete") {
    return (
      <p className={`text-[11px] font-semibold ${event.status === "completed" ? "text-emerald-400" : "text-red-400"}`}>
        ✓ {event.status}
      </p>
    );
  }
  return null;
}
