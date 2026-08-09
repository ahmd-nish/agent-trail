/**
 * Encrypted board env editor (Phase 3b).
 *
 * Lists, edits, and deletes per-board environment variables. Values are
 * stored encrypted on the server (AES-256-GCM) and arrive masked by default;
 * a per-row "👁" toggle decrypts and shows the plaintext.
 *
 * Test runs that reference `{{env.KEY}}` get the decrypted value at run time.
 */

import { useEffect, useState } from "react";
import { Eye, EyeOff, Trash2, Plus } from "lucide-react";
import { api, type BoardEnvEntry } from "../lib/api.ts";

interface Props {
  boardId: string;
}

interface Row {
  key: string;
  value: string;
  /** True for rows freshly added in the UI but not yet saved. */
  isNew?: boolean;
  /** True when the user has toggled "reveal" for this specific row. */
  revealed?: boolean;
  /** True while a save/delete is in flight for this row. */
  busy?: boolean;
  /** Last error from a save attempt; cleared on next edit. */
  error?: string;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function BoardEnvEditor({ boardId }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalReveal, setGlobalReveal] = useState(false);

  // Initial + on-board-change fetch
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.boards
      .listEnv(boardId, /*reveal=*/ false)
      .then((r) => {
        if (cancelled) return;
        setRows(entriesToRows(r.entries));
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [boardId]);

  async function refreshAll(reveal: boolean) {
    try {
      const r = await api.boards.listEnv(boardId, reveal);
      setRows(entriesToRows(r.entries, reveal));
      setGlobalReveal(reveal);
    } catch (err) {
      alert(`Could not load env: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function saveRow(idx: number) {
    const row = rows[idx];
    if (!row) return;
    if (!KEY_PATTERN.test(row.key)) {
      setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, error: "Invalid key (use [A-Za-z_][A-Za-z0-9_]*)" } : r)));
      return;
    }
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, busy: true, error: undefined } : r)));
    try {
      await api.boards.setEnv(boardId, [{ key: row.key, value: row.value }]);
      // After save the value is now persisted. Mark non-new + keep revealed state.
      setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, busy: false, isNew: false } : r)));
      window.dispatchEvent(new CustomEvent("inventarium:env-changed", { detail: { boardId } }));
    } catch (err) {
      setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, busy: false, error: err instanceof Error ? err.message : String(err) } : r)));
    }
  }

  async function deleteRow(idx: number) {
    const row = rows[idx];
    if (!row) return;
    if (row.isNew) {
      setRows((rs) => rs.filter((_, i) => i !== idx));
      return;
    }
    if (!confirm(`Delete env var "${row.key}"? This cannot be undone.`)) return;
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, busy: true } : r)));
    try {
      await api.boards.deleteEnv(boardId, row.key);
      setRows((rs) => rs.filter((_, i) => i !== idx));
      window.dispatchEvent(new CustomEvent("inventarium:env-changed", { detail: { boardId } }));
    } catch (err) {
      setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, busy: false, error: err instanceof Error ? err.message : String(err) } : r)));
    }
  }

  async function toggleRowReveal(idx: number) {
    const row = rows[idx];
    if (!row || row.isNew) return; // new rows already show their typed value
    if (row.revealed) {
      // Hide: refetch only this row's masked value to avoid keeping plaintext around
      try {
        const r = await api.boards.listEnv(boardId, false);
        const entry = r.entries.find((e) => e.key === row.key);
        setRows((rs) => rs.map((cur, i) => (i === idx ? { ...cur, value: entry?.value ?? cur.value, revealed: false } : cur)));
      } catch { /* noop */ }
    } else {
      try {
        const r = await api.boards.listEnv(boardId, true);
        const entry = r.entries.find((e) => e.key === row.key);
        setRows((rs) => rs.map((cur, i) => (i === idx ? { ...cur, value: entry?.value ?? cur.value, revealed: true } : cur)));
      } catch (err) {
        setRows((rs) => rs.map((cur, i) => (i === idx ? { ...cur, error: err instanceof Error ? err.message : String(err) } : cur)));
      }
    }
  }

  function addRow() {
    setRows((rs) => [...rs, { key: "", value: "", isNew: true, revealed: true }]);
  }

  function updateRow(idx: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch, error: undefined } : r)));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p style={{ fontSize: 10, color: "var(--fg-faded)" }}>
          Used by test cases via <code className="font-mono">{`{{env.KEY}}`}</code>. Encrypted at rest (AES-256-GCM).
        </p>
        <button
          onClick={() => refreshAll(!globalReveal)}
          className="text-[10px] px-1.5 py-0.5 rounded hover:bg-slate-800 flex items-center gap-1"
          style={{ color: "var(--fg-dim)" }}
        >
          {globalReveal ? <EyeOff size={10} /> : <Eye size={10} />}
          {globalReveal ? "Hide all" : "Reveal all"}
        </button>
      </div>

      {loading ? (
        <p className="text-[10px]" style={{ color: "var(--fg-faded)" }}>loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[10px] italic" style={{ color: "var(--fg-faded)" }}>
          No env vars yet. Add one to make secrets available to test cases.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row, i) => (
            <div key={`${row.key}-${i}`} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <input
                  value={row.key}
                  onChange={(e) => updateRow(i, { key: e.target.value })}
                  placeholder="API_KEY"
                  disabled={!row.isNew}
                  className="w-32 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-100 font-mono focus:outline-none placeholder:text-slate-600 disabled:opacity-60"
                />
                <span className="text-slate-600">=</span>
                <input
                  type={row.revealed || row.isNew ? "text" : "password"}
                  value={row.value}
                  onChange={(e) => updateRow(i, { value: e.target.value })}
                  placeholder={row.isNew ? "secret value" : ""}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-100 font-mono focus:outline-none placeholder:text-slate-600"
                />
                {!row.isNew && (
                  <button
                    onClick={() => toggleRowReveal(i)}
                    title={row.revealed ? "Hide value" : "Reveal value"}
                    className="text-slate-500 hover:text-indigo-400 p-1"
                  >
                    {row.revealed ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                )}
                <button
                  onClick={() => saveRow(i)}
                  disabled={row.busy || !row.key}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-700 hover:bg-indigo-600 text-white disabled:opacity-40"
                >
                  {row.busy ? "…" : row.isNew ? "Add" : "Save"}
                </button>
                <button
                  onClick={() => deleteRow(i)}
                  disabled={row.busy}
                  className="text-slate-500 hover:text-red-400 p-1 disabled:opacity-40"
                  title="Delete"
                >
                  <Trash2 size={11} />
                </button>
              </div>
              {row.error && (
                <p className="text-[10px] text-red-400 pl-1">{row.error}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        onClick={addRow}
        className="self-start text-[10px] px-1.5 py-0.5 rounded hover:bg-slate-800 flex items-center gap-1"
        style={{ color: "var(--fg-dim)" }}
      >
        <Plus size={10} /> Add env var
      </button>
    </div>
  );
}

function entriesToRows(entries: BoardEnvEntry[], revealed = false): Row[] {
  return entries.map((e) => ({
    key: e.key,
    value: e.value,
    revealed: revealed && !e.masked,
  }));
}
