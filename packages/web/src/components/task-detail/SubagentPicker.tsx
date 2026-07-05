import { useEffect, useState } from "react";
import { Bot, X } from "lucide-react";
import { api, type AgentEntry } from "../../lib/api.ts";
import type { Task } from "../../../../core/src/types/index.ts";

interface Props {
  task: Task;
  onSave: (subagents: string[]) => void;
}

/**
 * PRD 1.8 — subagent picker on the task card. Renders a searchable multi-select
 * against `/api/agents` (project overrides > bundled). Toggling a chip persists
 * via the shared onSave, which PATCHes the task through the normal metadata flow.
 */
export function SubagentPicker({ task, onSave }: Props) {
  const [available, setAvailable] = useState<AgentEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.agents.list().then((rows) => { if (!cancelled) setAvailable(rows); }).catch(() => setAvailable([]));
    return () => { cancelled = true; };
  }, []);

  const selected = new Set(task.subagents);
  function toggle(name: string) {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name); else next.add(name);
    onSave(Array.from(next));
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px]" style={{ color: "var(--fg-faded)" }}>
        Subagents
      </label>
      {available === null && (
        <div className="text-[10px]" style={{ color: "var(--fg-faded)" }}>loading…</div>
      )}
      {available !== null && available.length === 0 && (
        <div className="text-[10px]" style={{ color: "var(--fg-faded)" }}>
          no subagents discovered — drop .md files into .claude/agents/
        </div>
      )}
      {available !== null && available.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {available.map((a) => {
            const on = selected.has(a.name);
            return (
              <button
                key={a.name}
                onClick={() => toggle(a.name)}
                title={a.description || a.name}
                className="claw-chip"
                style={{
                  gap: 3, cursor: "pointer",
                  borderColor: on ? "var(--green-line)" : undefined,
                  color: on ? "var(--green)" : "var(--fg-dim)",
                }}
              >
                <Bot size={9} />
                {a.name}
                {on && <X size={9} style={{ opacity: 0.6 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
