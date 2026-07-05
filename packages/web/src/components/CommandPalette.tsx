import { useState, useEffect, useRef, useCallback } from "react";
import { Search, Play, Square, Plus, Settings, LayoutDashboard, Columns3, BarChart3, GitBranch } from "lucide-react";
import type { Task, Board } from "../../../core/src/types/index.ts";
import { fuzzyFilter } from "../lib/fuzzy.ts";

interface Command {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  action: () => void | Promise<void>;
}

interface Props {
  tasks: Task[];
  boards: Board[];
  currentView: string;
  onViewChange: (v: "board" | "dag" | "epics" | "dashboard") => void;
  onRunTask: (taskId: string) => void;
  onOpenTask: (task: Task) => void;
  onNewTask: (status: "backlog") => void;
  onNewBoard: () => void;
  onOpenSettings: () => void;
}

export function CommandPalette({ tasks, boards, currentView, onViewChange, onRunTask, onOpenTask, onNewTask, onNewBoard, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setOpen((x) => !x); }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) { setQuery(""); setSelectedIdx(0); setTimeout(() => inputRef.current?.focus(), 10); }
  }, [open]);

  const staticCommands: Command[] = [
    { id: "view-board",     label: "switch to board",     icon: <Columns3 size={12} />,       action: () => { onViewChange("board"); setOpen(false); } },
    { id: "view-dag",       label: "switch to dag",       icon: <GitBranch size={12} />,       action: () => { onViewChange("dag"); setOpen(false); } },
    { id: "view-epics",     label: "switch to epics",     icon: <LayoutDashboard size={12} />, action: () => { onViewChange("epics"); setOpen(false); } },
    { id: "view-dashboard", label: "switch to dashboard", icon: <BarChart3 size={12} />,       action: () => { onViewChange("dashboard"); setOpen(false); } },
    { id: "new-task",       label: "new task in backlog", icon: <Plus size={12} />,            action: () => { onNewTask("backlog"); setOpen(false); } },
    { id: "new-board",      label: "new board",           icon: <Plus size={12} />,            action: () => { onNewBoard(); setOpen(false); } },
    { id: "open-settings",  label: "open settings",       icon: <Settings size={12} />,        action: () => { onOpenSettings(); setOpen(false); } },
  ];

  const taskCommands: Command[] = tasks
    .filter((t) => t.status !== "done")
    .map((t) => ({
      id: `task-open-${t.id}`,
      label: t.title,
      description: t.status === "in_progress" ? "running…" : t.status.replace("_", " "),
      icon: t.status === "in_progress"
        ? <Square size={12} style={{ color: "var(--green)" }} />
        : <Play size={12} style={{ color: "var(--blue)" }} />,
      action: () => { onOpenTask(t); setOpen(false); },
    }));

  const allCommands = [...staticCommands, ...taskCommands];
  const filtered = query.trim() ? fuzzyFilter(query, allCommands, (c) => c.label) : allCommands;
  const totalItems = filtered.length;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, totalItems - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); filtered[selectedIdx]?.action(); }
    else if (e.key === "Escape") setOpen(false);
  }, [filtered, selectedIdx, totalItems]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  useEffect(() => setSelectedIdx(0), [query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center" style={{ paddingTop: "14vh" }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.75)" }} onClick={() => setOpen(false)} />

      <div
        className="relative z-10 w-full overflow-hidden"
        style={{
          maxWidth: 520,
          background: "var(--bg-pane)",
          border: "1px solid var(--line)",
          borderRadius: 4,
        }}
      >
        {/* Search */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
          <Search size={12} style={{ color: "var(--fg-faded)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="type a command or task name…"
            className="flex-1 bg-transparent focus:outline-none"
            style={{ color: "var(--fg)", fontSize: 11, fontFamily: "inherit" }}
          />
          <span
            className="shrink-0"
            style={{ fontSize: 9, color: "var(--fg-faded)", border: "1px solid var(--line)", borderRadius: 2, padding: "1px 4px", fontFamily: "inherit" }}
          >
            esc
          </span>
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: 320 }}>
          {filtered.length === 0 ? (
            <p className="px-4 py-3 text-center" style={{ fontSize: 11, color: "var(--fg-faded)" }}>
              no matches for "{query}"
            </p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                data-idx={i}
                onClick={() => cmd.action()}
                onMouseEnter={() => setSelectedIdx(i)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
                style={{
                  background: i === selectedIdx ? "var(--bg-panel)" : "transparent",
                  borderLeft: i === selectedIdx ? `2px solid var(--green)` : "2px solid transparent",
                  fontFamily: "inherit",
                }}
              >
                <span style={{ color: "var(--fg-faded)", flexShrink: 0 }}>{cmd.icon}</span>
                <span className="flex-1" style={{ fontSize: 11, color: "var(--fg)" }}>{cmd.label}</span>
                {cmd.description && (
                  <span style={{ fontSize: 10, color: "var(--fg-faded)" }}>{cmd.description}</span>
                )}
              </button>
            ))
          )}
        </div>

        <div
          className="flex items-center gap-4 px-4 py-2"
          style={{ borderTop: "1px solid var(--line-dim)", fontSize: 10, color: "var(--fg-faded)" }}
        >
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          <span className="ml-auto">⌘k toggle</span>
        </div>
      </div>
    </div>
  );
}
