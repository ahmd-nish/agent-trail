import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task, Priority } from "../../../core/src/types/index.ts";

const priorityColors: Record<Priority, string> = {
  low: "bg-slate-700 text-slate-300",
  medium: "bg-blue-900 text-blue-300",
  high: "bg-amber-900 text-amber-300",
  critical: "bg-red-900 text-red-300",
};

interface Props {
  task: Task;
  onClick: (task: Task) => void;
}

export function TaskCard({ task, onClick }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onClick(task)}
      className="bg-slate-800 border border-slate-700 rounded-lg p-3 cursor-pointer hover:border-slate-500 select-none"
    >
      <div className="flex items-center gap-2 mb-2">
        {task.status === "in_progress" && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
        )}
        {task.status === "blocked" && task.activeForm && (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
        )}
        <p className="text-sm text-slate-100 font-medium leading-snug">{task.title}</p>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${priorityColors[task.priority]}`}>
          {task.priority}
        </span>
        {task.tddEnabled && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-300">
            TDD
          </span>
        )}
        {task.mcps.map((mcp) => (
          <span key={mcp} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900 text-purple-300">
            {mcp}
          </span>
        ))}
        {task.assignee !== "claude-code" && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
            {task.assignee}
          </span>
        )}
      </div>
    </div>
  );
}
