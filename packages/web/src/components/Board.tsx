import { useState, useCallback, useRef, useEffect } from "react";
import {
  DndContext, DragOverlay, closestCorners, PointerSensor,
  useSensor, useSensors, type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import type { Task, TaskStatus } from "../../../core/src/types/index.ts";
import { TaskCard } from "./TaskCard.tsx";

interface ColumnDef {
  id: TaskStatus;
  label: string;
  accentColor: string;
  emptyMsg: string;
}

const COLUMNS: ColumnDef[] = [
  { id: "backlog",     label: "backlog",     accentColor: "var(--fg-faded)", emptyMsg: "> backlog clear. nothing queued." },
  { id: "ready",       label: "ready",       accentColor: "var(--blue)",     emptyMsg: "> agents standing by." },
  { id: "in_progress", label: "in_progress", accentColor: "var(--green)",    emptyMsg: "> all agents idle." },
  { id: "blocked",     label: "blocked",     accentColor: "var(--red)",      emptyMsg: "> all clear, no blockers." },
  { id: "in_review",   label: "in_review",   accentColor: "var(--purple)",   emptyMsg: "> nothing to review." },
  { id: "done",        label: "done",        accentColor: "rgba(94,232,157,0.5)", emptyMsg: "> no completions yet. ship something." },
];

/** Types out a string one character at a time. */
function TypewriterMsg({ text }: { text: string }) {
  const [displayed, setDisplayed] = useState("");
  const posRef = useRef(0);

  useEffect(() => {
    posRef.current = 0;
    setDisplayed("");
    const id = setInterval(() => {
      posRef.current += 1;
      setDisplayed(text.slice(0, posRef.current));
      if (posRef.current >= text.length) clearInterval(id);
    }, 28);
    return () => clearInterval(id);
  }, [text]);

  const done = displayed.length === text.length;

  return (
    <span
      className={done ? "" : "blink-cursor"}
      style={{ fontFamily: "inherit", color: "var(--fg-faded)", fontSize: 10 }}
    >
      {displayed}
    </span>
  );
}

function Column({ col, tasks, onTaskClick }: { col: ColumnDef; tasks: Task[]; onTaskClick: (task: Task) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id });

  return (
    <div
      ref={setNodeRef}
      className="flex flex-col gap-1.5 min-h-[160px] p-2 rounded transition-all duration-150"
      style={{
        background: isOver ? "rgba(94,232,157,0.04)" : "transparent",
        border: `1px solid ${isOver ? "var(--green-line)" : "var(--line-dim)"}`,
      }}
    >
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onClick={onTaskClick} />
        ))}
      </SortableContext>

      {tasks.length === 0 && (
        <div className="flex items-center justify-center h-12 px-2">
          <TypewriterMsg text={col.emptyMsg} />
        </div>
      )}
    </div>
  );
}

interface Props {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onAddTask: (status: TaskStatus, title: string) => void | Promise<void>;
}

export function Board({ tasks, onTaskClick, onStatusChange, onAddTask }: Props) {
  const [dragging, setDragging] = useState<Task | null>(null);
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => { if (adding && inputRef.current) inputRef.current.focus(); }, [adding]);

  const tasksByStatus = useCallback(
    (status: TaskStatus) => tasks.filter((t) => t.status === status),
    [tasks],
  );

  function handleDragStart(e: DragStartEvent) { setDragging(tasks.find((t) => t.id === e.active.id) ?? null); }

  function handleDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const newStatus = over.id as TaskStatus;
    const task = tasks.find((t) => t.id === active.id);
    if (task && task.status !== newStatus && COLUMNS.some((c) => c.id === newStatus)) onStatusChange(task.id, newStatus);
  }

  function cancelAdding() { setAdding(null); setDraft(""); }

  async function commitAdding(status: TaskStatus) {
    const title = draft.trim();
    if (!title) { cancelAdding(); return; }
    cancelAdding();
    await onAddTask(status, title);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="board-surface rounded p-4 h-full" style={{ border: "1px solid var(--line-dim)" }}>
        <div className="grid grid-cols-6 gap-3 h-full">
          {COLUMNS.map((col) => {
            const colTasks = tasksByStatus(col.id);
            const hasLive = col.id === "in_progress" && colTasks.length > 0;

            return (
              <div key={col.id} className="flex flex-col gap-2">
                {/* // column header */}
                <div className="flex items-center justify-between py-1" style={{ borderBottom: "1px solid var(--line-dim)" }}>
                  <div className="flex items-center gap-1.5">
                    <span style={{ color: "var(--fg-faded)", fontSize: 10 }}>//</span>
                    <span className="text-[11px] font-medium tracking-wide" style={{ color: col.accentColor }}>
                      {col.label}
                    </span>
                    {hasLive && (
                      <span className="w-1.5 h-1.5 rounded-full col-active-dot shrink-0" style={{ background: "var(--green)" }} />
                    )}
                  </div>
                  <span className="text-[10px] tabular-nums" style={{ color: "var(--fg-faded)" }}>
                    {colTasks.length || ""}
                  </span>
                </div>

                {/* Inline add */}
                {adding === col.id ? (
                  <input
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitAdding(col.id); else if (e.key === "Escape") cancelAdding(); }}
                    onBlur={() => commitAdding(col.id)}
                    placeholder="task title…"
                    className="text-[11px] px-2 py-1 rounded focus:outline-none"
                    style={{ background: "var(--bg-panel)", border: "1px solid var(--green-line)", color: "var(--fg)", fontFamily: "inherit" }}
                  />
                ) : (
                  <button
                    onClick={() => { setAdding(col.id); setDraft(""); }}
                    className="text-[10px] text-left px-1 py-0.5 rounded transition-colors"
                    style={{ color: "var(--fg-faded)", fontFamily: "inherit" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-dim)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-faded)")}
                  >
                    + add
                  </button>
                )}

                <Column col={col} tasks={colTasks} onTaskClick={onTaskClick} />
              </div>
            );
          })}
        </div>
      </div>

      <DragOverlay>
        {dragging && (
          <div
            className="rounded px-3 py-2 shadow-2xl rotate-1 scale-105"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--green-line)", color: "var(--green)", fontSize: 12, fontFamily: "inherit" }}
          >
            {dragging.title}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
