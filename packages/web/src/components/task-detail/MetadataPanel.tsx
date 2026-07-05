import { useState } from "react";
import type { Task, TaskStatus, Priority, AgentKind, ReviewKind } from "../../../../core/src/types/index.ts";
import { Field, StatusDot } from "./atoms.tsx";
import { SubagentPicker } from "./SubagentPicker.tsx";

const STATUSES: TaskStatus[] = ["backlog", "ready", "in_progress", "blocked", "in_review", "done"];
const PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];
const AGENTS: AgentKind[] = ["claude-code", "codex", "gemini", "custom"];
const REVIEW_KINDS: ReviewKind[] = ["none", "automated", "browser", "human"];
const REVIEW_LABELS: Record<ReviewKind, string> = {
  none: "None",
  automated: "Automated (schema/assertions)",
  browser: "Browser (MCP-based)",
  human: "Human (blocks until clarified)",
};

const inputCls = "focus:outline-none w-full";
const inputSmCls = "focus:outline-none w-full";
const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--line)",
  color: "var(--fg)",
  fontFamily: "inherit",
  fontSize: 11,
  borderRadius: 2,
  padding: "4px 8px",
};

interface Props {
  task: Task;
  form: Partial<Task>;
  setForm: (updater: (f: Partial<Task>) => Partial<Task>) => void;
  save: (patch: Partial<Task>) => Promise<void>;
  boardTasks: Task[];
}

export function MetadataPanel({ task, form, setForm, save, boardTasks }: Props) {
  const [mcpInput, setMcpInput] = useState("");
  const [extDepInput, setExtDepInput] = useState("");
  const [depSearch, setDepSearch] = useState("");

  // form value with task fallback
  const f = <K extends keyof Task>(key: K): Task[K] =>
    (form[key] !== undefined ? form[key] : task[key]) as Task[K];

  const currentMcps: string[] = (f("mcps") as string[] | undefined) ?? [];
  const currentDeps: string[] = (f("dependsOn") as string[] | undefined) ?? [];
  const currentExtDeps: string[] = (f("externalDependencies") as string[] | undefined) ?? [];

  const otherTasks = boardTasks.filter((t) => t.id !== task.id);
  const filteredDeps = depSearch.trim()
    ? otherTasks.filter(
        (t) =>
          t.title.toLowerCase().includes(depSearch.toLowerCase()) ||
          t.id.toLowerCase().includes(depSearch.toLowerCase()),
      )
    : otherTasks;

  function toggleDep(depId: string) {
    const next = currentDeps.includes(depId)
      ? currentDeps.filter((id) => id !== depId)
      : [...currentDeps, depId];
    save({ dependsOn: next });
  }

  const IS = { ...inputStyle };

  return (
    <div className="w-[340px] shrink-0 overflow-y-auto flex flex-col gap-3 p-4" style={{ borderRight: "1px solid var(--line)" }}>

      <Field label="Title">
        <input
          className={inputCls}
          style={IS}
          value={(form.title as string) ?? task.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          onBlur={() => form.title !== task.title && save({ title: form.title })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Status">
          <select className={inputCls} style={IS} value={f("status")} onChange={(e) => save({ status: e.target.value as TaskStatus })}>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className={inputCls} style={IS} value={f("priority")} onChange={(e) => save({ priority: e.target.value as Priority })}>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Assignee">
          <select className={inputCls} style={IS} value={f("assignee")} onChange={(e) => save({ assignee: e.target.value as AgentKind })}>
            {AGENTS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Model tier">
          <select
            className={inputCls}
            style={IS}
            value={(form.modelTier as string | null) ?? task.modelTier ?? ""}
            onChange={(e) => {
              const val = e.target.value === "" ? null : (e.target.value as "haiku" | "sonnet" | "opus");
              setForm((f) => ({ ...f, modelTier: val }));
              save({ modelTier: val });
            }}
          >
            <option value="">(auto)</option>
            <option value="haiku">haiku — fast, cheap</option>
            <option value="sonnet">sonnet — default</option>
            <option value="opus">opus — hard reasoning</option>
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Model (override)">
          <input
            className={inputCls}
            style={IS}
            placeholder="claude-opus-4-7 (overrides tier)"
            value={(form.model as string | null) ?? task.model ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            onBlur={() => {
              const val = (form.model ?? "") as string;
              if (val !== (task.model ?? "")) save({ model: val || null });
            }}
          />
        </Field>
        <div />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Epic">
          <input
            className={inputCls} style={IS}
            placeholder="e.g. Auth"
            value={(form.epic as string | null) ?? task.epic ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, epic: e.target.value }))}
            onBlur={() => { const val = (form.epic ?? "") as string; if (val !== (task.epic ?? "")) save({ epic: val || null }); }}
          />
        </Field>
        <Field label="Sprint">
          <input
            className={inputCls} style={IS}
            placeholder="e.g. Sprint 1"
            value={(form.sprint as string | null) ?? task.sprint ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, sprint: e.target.value }))}
            onBlur={() => { const val = (form.sprint ?? "") as string; if (val !== (task.sprint ?? "")) save({ sprint: val || null }); }}
          />
        </Field>
      </div>

      <Field label="Component">
        <input
          className={inputCls} style={IS}
          placeholder="e.g. LoginForm, /api/auth"
          value={(form.component as string | null) ?? task.component ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, component: e.target.value }))}
          onBlur={() => { const val = (form.component ?? "") as string; if (val !== (task.component ?? "")) save({ component: val || null }); }}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Review kind">
          <select className={inputCls} style={IS} value={(f("reviewKind") as ReviewKind | undefined) ?? "none"} onChange={(e) => save({ reviewKind: e.target.value as ReviewKind })}>
            {REVIEW_KINDS.map((k) => <option key={k} value={k}>{REVIEW_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Reviewer">
          <input
            className={inputCls} style={IS}
            placeholder="@handle"
            value={(form.reviewer as string | null) ?? task.reviewer ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, reviewer: e.target.value }))}
            onBlur={() => { const val = (form.reviewer ?? "") as string; if (val !== (task.reviewer ?? "")) save({ reviewer: val || null }); }}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={f("tddEnabled") as boolean}
          onChange={(e) => save({ tddEnabled: e.target.checked })}
          style={{ accentColor: "var(--green)", width: 13, height: 13 }}
        />
        <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>tdd gate enabled</span>
      </label>

      {/* MCPs */}
      <div className="flex flex-col gap-1.5">
        <span style={{ fontSize: 10, color: "var(--fg-faded)", letterSpacing: "0.05em", textTransform: "uppercase" as const, fontWeight: 500 }}>mcps</span>
        <div className="flex flex-wrap gap-1">
          {currentMcps.map((mcp) => (
            <span key={mcp} className="claw-chip purple flex items-center gap-1">
              {mcp}
              <button onClick={() => save({ mcps: currentMcps.filter((m) => m !== mcp) })} style={{ color: "var(--purple)", opacity: 0.7, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
        <input
          className={inputCls} style={IS}
          placeholder="add mcp server…"
          value={mcpInput}
          onChange={(e) => setMcpInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && mcpInput.trim()) { save({ mcps: [...currentMcps, mcpInput.trim()] }); setMcpInput(""); } }}
        />
      </div>

      {/* Subagent picker — PRD 1.8 */}
      <SubagentPicker task={task} onSave={(subagents) => save({ subagents })} />

      {/* Task dependencies */}
      <div className="flex flex-col gap-1.5">
        <span style={{ fontSize: 10, color: "var(--fg-faded)", letterSpacing: "0.05em", textTransform: "uppercase" as const, fontWeight: 500 }}>depends on tasks</span>
        {currentDeps.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {currentDeps.map((depId) => {
              const dep = boardTasks.find((t) => t.id === depId);
              return (
                <span key={depId} className="claw-chip flex items-center gap-1">
                  {dep?.title ?? depId.slice(0, 8)}
                  <button onClick={() => toggleDep(depId)} style={{ color: "var(--fg-faded)", lineHeight: 1 }}>×</button>
                </span>
              );
            })}
          </div>
        )}
        {otherTasks.length > 0 && (
          <>
            <input
              className={inputCls} style={IS}
              placeholder="search tasks…"
              value={depSearch}
              onChange={(e) => setDepSearch(e.target.value)}
            />
            <div className="max-h-28 overflow-y-auto flex flex-col" style={{ border: "1px solid var(--line)", borderRadius: 2 }}>
              {filteredDeps.length === 0
                ? <p className="px-2 py-1.5" style={{ fontSize: 10, color: "var(--fg-faded)" }}>no matching tasks</p>
                : filteredDeps.map((t) => {
                  const checked = currentDeps.includes(t.id);
                  return (
                    <label
                      key={t.id}
                      className="flex items-center gap-2 px-2 py-1.5 cursor-pointer transition-colors"
                      style={{ fontSize: 11, color: checked ? "var(--green)" : "var(--fg-dim)", background: checked ? "rgba(94,232,157,0.06)" : "transparent", fontFamily: "inherit" }}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleDep(t.id)} style={{ accentColor: "var(--green)" }} />
                      <span className="truncate flex-1">{t.title}</span>
                      <StatusDot status={t.status} />
                    </label>
                  );
                })}
            </div>
          </>
        )}
      </div>

      {/* External blockers */}
      <div className="flex flex-col gap-1.5">
        <span style={{ fontSize: 10, color: "var(--fg-faded)", letterSpacing: "0.05em", textTransform: "uppercase" as const, fontWeight: 500 }}>external blockers</span>
        <div className="flex flex-col gap-1">
          {currentExtDeps.map((dep, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <span style={{ color: "var(--fg-faded)", fontSize: 10, flexShrink: 0 }}>•</span>
              <span style={{ fontSize: 11, color: "var(--fg-dim)", flex: 1, lineHeight: 1.5 }}>{dep}</span>
              <button
                onClick={() => save({ externalDependencies: currentExtDeps.filter((_, j) => j !== i) })}
                style={{ color: "var(--fg-faded)", fontSize: 12, lineHeight: 1, opacity: 0, transition: "opacity 0.15s" }}
                className="group-hover:opacity-100 shrink-0"
              >×</button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className="flex-1 focus:outline-none"
            style={IS}
            placeholder="e.g. design approval…"
            value={extDepInput}
            onChange={(e) => setExtDepInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && extDepInput.trim()) {
                save({ externalDependencies: [...currentExtDeps, extDepInput.trim()] });
                setExtDepInput("");
              }
            }}
          />
          <button
            onClick={() => {
              if (extDepInput.trim()) {
                save({ externalDependencies: [...currentExtDeps, extDepInput.trim()] });
                setExtDepInput("");
              }
            }}
            className="claw-btn shrink-0"
            style={{ fontSize: 10, padding: "3px 8px" }}
          >Add</button>
        </div>
      </div>
    </div>
  );
}
