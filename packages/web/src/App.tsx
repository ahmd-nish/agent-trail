import { useState, useEffect, useCallback } from "react";
import type { Board, Task, TaskStatus } from "../../core/src/types/index.ts";
import { api } from "./lib/api.ts";
import { Board as KanbanBoard } from "./components/Board.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { DagView } from "./components/DagView.tsx";

type View = "board" | "dag";

export function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [view, setView] = useState<View>("board");
  const [newBoardName, setNewBoardName] = useState("");
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);

  // Load boards on mount
  useEffect(() => {
    api.boards.list().then((bs) => {
      setBoards(bs);
      if (bs.length > 0 && !activeBoardId) setActiveBoardId(bs[0]!.id);
    });
  }, []);

  // Load tasks when active board changes
  useEffect(() => {
    if (!activeBoardId) return;
    setLoadingTasks(true);
    api.tasks
      .list(activeBoardId)
      .then(setTasks)
      .finally(() => setLoadingTasks(false));
  }, [activeBoardId]);

  const createBoard = useCallback(async () => {
    const name = newBoardName.trim();
    if (!name) return;
    setCreatingBoard(true);
    try {
      const board = await api.boards.create(name);
      setBoards((bs) => [board, ...bs]);
      setActiveBoardId(board.id);
      setTasks([]);
      setNewBoardName("");
    } finally {
      setCreatingBoard(false);
    }
  }, [newBoardName]);

  const handleStatusChange = useCallback(async (taskId: string, status: TaskStatus) => {
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)));
    await api.tasks.update(taskId, { status });
  }, []);

  const handleAddTask = useCallback(
    async (status: TaskStatus) => {
      if (!activeBoardId) return;
      const title = prompt("Task title:");
      if (!title?.trim()) return;
      const task = await api.tasks.create(activeBoardId, { title: title.trim(), status });
      setTasks((ts) => [...ts, task]);
    },
    [activeBoardId],
  );

  const handleTaskUpdated = useCallback((updated: Task) => {
    setTasks((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    setSelectedTask(updated);
  }, []);

  const handleTaskDeleted = useCallback((taskId: string) => {
    setTasks((ts) => ts.filter((t) => t.id !== taskId));
    setSelectedTask(null);
  }, []);

  const activeBoard = boards.find((b) => b.id === activeBoardId);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-4 px-5 py-3 border-b border-slate-800 shrink-0">
        <span className="font-bold text-slate-100 tracking-tight text-sm">agent-trail</span>

        {/* Board selector */}
        <div className="flex items-center gap-2 flex-1">
          <select
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none"
            value={activeBoardId ?? ""}
            onChange={(e) => setActiveBoardId(e.target.value || null)}
          >
            {boards.length === 0 && <option value="">No boards</option>}
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>

          {/* New board */}
          <input
            placeholder="New board name…"
            value={newBoardName}
            onChange={(e) => setNewBoardName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createBoard()}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-slate-500 w-44 placeholder:text-slate-600"
          />
          <button
            onClick={createBoard}
            disabled={creatingBoard || !newBoardName.trim()}
            className="text-xs px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white"
          >
            Create
          </button>
        </div>

        {/* View switcher */}
        <div className="flex gap-1 bg-slate-800 rounded p-0.5">
          {(["board", "dag"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                view === v ? "bg-slate-600 text-slate-100" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {v === "board" ? "Kanban" : "DAG"}
            </button>
          ))}
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 overflow-hidden p-5">
        {!activeBoardId ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">
            Create a board to get started
          </div>
        ) : loadingTasks ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">
            Loading…
          </div>
        ) : view === "board" ? (
          <KanbanBoard
            tasks={tasks}
            onTaskClick={setSelectedTask}
            onStatusChange={handleStatusChange}
            onAddTask={handleAddTask}
          />
        ) : (
          <DagView tasks={tasks} />
        )}
      </main>

      {/* Task detail panel */}
      <TaskDetail
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onUpdated={handleTaskUpdated}
        onDeleted={handleTaskDeleted}
      />
    </div>
  );
}
