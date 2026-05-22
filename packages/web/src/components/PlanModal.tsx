import { useState } from "react";
import { api, type PlanResult } from "../lib/api.ts";
import type { Board } from "../../../core/src/types/index.ts";

interface Props {
  boards: Board[];
  activeBoardId: string | null;
  onDone: (result: PlanResult) => void;
  onClose: () => void;
}

export function PlanModal({ boards, activeBoardId, onDone, onClose }: Props) {
  const [prdText, setPrdText] = useState("");
  const [boardChoice, setBoardChoice] = useState<"new" | "existing">("new");
  const [newName, setNewName] = useState("");
  const [selectedBoardId, setSelectedBoardId] = useState(activeBoardId ?? "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!prdText.trim()) return;
    if (boardChoice === "new" && !newName.trim()) return;
    if (boardChoice === "existing" && !selectedBoardId) return;

    setRunning(true);
    setError(null);
    try {
      const result = await api.boards.plan({
        prdText: prdText.trim(),
        ...(boardChoice === "new"
          ? { name: newName.trim() }
          : { boardId: selectedBoardId }),
      });
      onDone(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[600px] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div>
            <h2 className="text-slate-100 font-semibold text-base">Plan from PRD</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Paste a product requirements doc — the planner will generate a task graph
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4 overflow-y-auto flex-1">
          {/* Board target */}
          <div className="flex flex-col gap-2">
            <span className="text-xs text-slate-400 font-medium">Target board</span>
            <div className="flex gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="boardChoice"
                  checked={boardChoice === "new"}
                  onChange={() => setBoardChoice("new")}
                  className="accent-indigo-500"
                />
                <span className="text-sm text-slate-300">New board</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="boardChoice"
                  checked={boardChoice === "existing"}
                  onChange={() => setBoardChoice("existing")}
                  className="accent-indigo-500"
                  disabled={boards.length === 0}
                />
                <span className="text-sm text-slate-300">Existing board</span>
              </label>
            </div>

            {boardChoice === "new" ? (
              <input
                autoFocus
                placeholder="Board name…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-slate-400"
              />
            ) : (
              <select
                value={selectedBoardId}
                onChange={(e) => setSelectedBoardId(e.target.value)}
                className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-slate-100 text-sm focus:outline-none"
              >
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* PRD text */}
          <label className="flex flex-col gap-1 flex-1">
            <span className="text-xs text-slate-400 font-medium">PRD</span>
            <textarea
              rows={14}
              placeholder="Paste your product requirements doc here…"
              value={prdText}
              onChange={(e) => setPrdText(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-slate-400 resize-none font-mono leading-relaxed"
            />
          </label>

          {error && (
            <p className="text-xs text-red-400 bg-red-950/40 border border-red-800/50 rounded p-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-slate-700">
          <p className="text-xs text-slate-500">Uses claude CLI — no API key needed</p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={running || !prdText.trim() || (boardChoice === "new" && !newName.trim())}
              className="text-xs px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium flex items-center gap-1.5"
            >
              {running ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                  Planning…
                </>
              ) : (
                "Generate tasks"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
