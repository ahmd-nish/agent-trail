import { useState, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import type { Task, TaskStatus } from "../../../core/src/types/index.ts";
import { TaskCard } from "./TaskCard.tsx";

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In Progress" },
  { id: "blocked", label: "Blocked" },
  { id: "in_review", label: "In Review" },
  { id: "done", label: "Done" },
];

function Column({
  status,
  label,
  tasks,
  onTaskClick,
}: {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-2 min-h-[200px] p-2 rounded-lg transition-colors ${
        isOver ? "bg-slate-700/50" : "bg-slate-800/30"
      }`}
    >
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onClick={onTaskClick} />
        ))}
      </SortableContext>
      {tasks.length === 0 && (
        <div className="flex items-center justify-center h-16 text-slate-600 text-xs">
          Drop here
        </div>
      )}
    </div>
  );
}

interface Props {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onAddTask: (status: TaskStatus) => void;
}

export function Board({ tasks, onTaskClick, onStatusChange, onAddTask }: Props) {
  const [dragging, setDragging] = useState<Task | null>(null);

  const tasksByStatus = useCallback(
    (status: TaskStatus) => tasks.filter((t) => t.status === status),
    [tasks],
  );

  function handleDragStart(e: DragStartEvent) {
    const task = tasks.find((t) => t.id === e.active.id);
    setDragging(task ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const newStatus = over.id as TaskStatus;
    const task = tasks.find((t) => t.id === active.id);
    if (task && task.status !== newStatus && COLUMNS.some((c) => c.id === newStatus)) {
      onStatusChange(task.id, newStatus);
    }
  }

  return (
    <DndContext collisionDetection={closestCorners} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="grid grid-cols-6 gap-3 h-full">
        {COLUMNS.map(({ id, label }) => (
          <div key={id} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</span>
              <span className="text-xs text-slate-600">{tasksByStatus(id).length}</span>
            </div>
            <button
              onClick={() => onAddTask(id)}
              className="text-xs text-slate-600 hover:text-slate-400 text-left px-2 py-1 rounded hover:bg-slate-800"
            >
              + add
            </button>
            <Column status={id} label={label} tasks={tasksByStatus(id)} onTaskClick={onTaskClick} />
          </div>
        ))}
      </div>

      <DragOverlay>
        {dragging && (
          <div className="bg-slate-800 border border-slate-500 rounded-lg p-3 shadow-xl opacity-90">
            <p className="text-sm text-slate-100 font-medium">{dragging.title}</p>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
