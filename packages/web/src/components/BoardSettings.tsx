import { useState, useRef, useEffect } from "react";
import type { Board } from "../../../core/src/types/index.ts";
import { api } from "../lib/api.ts";

interface Props {
  board: Board;
  onUpdated: (board: Board) => void;
}

export function BoardSettings({ board, onUpdated }: Props) {
  const [open, setOpen] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState(board.webhookUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Sync if active board changes
  useEffect(() => {
    setWebhookUrl(board.webhookUrl ?? "");
    setSaved(false);
  }, [board.id, board.webhookUrl]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function save() {
    setSaving(true);
    try {
      const updated = await api.boards.update(board.id, {
        webhookUrl: webhookUrl.trim() || null,
      });
      onUpdated(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((x) => !x)}
        title="Board settings"
        className={`text-sm px-2 py-1 rounded transition-colors ${
          open ? "text-slate-200 bg-slate-700" : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"
        }`}
      >
        ⚙
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-30 w-72 bg-slate-900 border border-slate-700 rounded-lg shadow-xl p-4 flex flex-col gap-3">
          <p className="text-xs font-semibold text-slate-300">Board settings</p>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Webhook URL</span>
            <input
              autoFocus
              placeholder="https://hooks.slack.com/… or any URL"
              value={webhookUrl}
              onChange={(e) => { setWebhookUrl(e.target.value); setSaved(false); }}
              onKeyDown={(e) => e.key === "Enter" && save()}
              className="bg-slate-800 border border-slate-600 rounded px-2.5 py-1.5 text-slate-100 text-xs focus:outline-none focus:border-slate-400 placeholder:text-slate-600"
            />
            <p className="text-[10px] text-slate-600">
              Fires on task completed, failed, or awaiting decision.
              Slack, Discord, and custom endpoints supported.
            </p>
          </label>

          <div className="flex items-center justify-between">
            {saved && <span className="text-[11px] text-emerald-400">Saved</span>}
            {!saved && <span />}
            <button
              onClick={save}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
