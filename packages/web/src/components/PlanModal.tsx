import { useState, useEffect, useRef } from "react";
import { FolderOpen, FileText, Wand2, X } from "lucide-react";
import { api, type PlanResult, type ExampleFile } from "../lib/api.ts";
import type { Board } from "../../../core/src/types/index.ts";

interface Props {
  boards: Board[];
  activeBoardId: string | null;
  onDone: (result: PlanResult) => void;
  onClose: () => void;
}

const MAX_PRD_BYTES = 2 * 1024 * 1024;

const S = {
  input: {
    background: "var(--bg-panel)",
    border: "1px solid var(--line)",
    color: "var(--fg)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 2,
    padding: "5px 8px",
    width: "100%",
    outline: "none",
  } as React.CSSProperties,
  label: {
    fontSize: 10,
    color: "var(--fg-faded)",
    letterSpacing: "0.05em",
    textTransform: "uppercase" as const,
    fontWeight: 500,
  },
};

export function PlanModal({ boards, activeBoardId, onDone, onClose }: Props) {
  const [prdText, setPrdText] = useState("");
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [boardChoice, setBoardChoice] = useState<"new" | "existing">("new");
  const [newName, setNewName] = useState("");
  const [selectedBoardId, setSelectedBoardId] = useState(activeBoardId ?? "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [examples, setExamples] = useState<ExampleFile[]>([]);
  const [examplesLoaded, setExamplesLoaded] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.examples.list().then(setExamples).catch(() => setExamples([])).finally(() => setExamplesLoaded(true));
  }, []);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault(); depth++; setDragActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault(); depth = 0; setDragActive(false);
      const file = e.dataTransfer.files[0];
      if (file) loadFromFile(file);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    if (boardChoice !== "new" || newName.trim()) return;
    const m = prdText.match(/^#\s+(?:PRD:\s*)?(.+?)\s*$/m);
    if (m?.[1]) setNewName(m[1].trim());
  }, [prdText, boardChoice]);

  function loadFromFile(file: File) {
    setError(null);
    if (file.size > MAX_PRD_BYTES) {
      setError(`file too large (${(file.size / 1024).toFixed(0)} KB)`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPrdText(typeof reader.result === "string" ? reader.result : "");
      setSourceLabel(file.name);
    };
    reader.onerror = () => setError("failed to read file");
    reader.readAsText(file);
  }

  async function loadExample(name: string) {
    if (!name) return;
    setError(null);
    try {
      const { content } = await api.examples.get(name);
      setPrdText(content);
      setSourceLabel(`examples/${name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load example");
    }
  }

  async function submit() {
    if (!prdText.trim()) return;
    if (boardChoice === "new" && !newName.trim()) return;
    if (boardChoice === "existing" && !selectedBoardId) return;
    setRunning(true); setError(null);
    try {
      const result = await api.boards.plan({
        prdText: prdText.trim(),
        ...(boardChoice === "new" ? { name: newName.trim() } : { boardId: selectedBoardId }),
      });
      onDone(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.75)" }} onClick={running ? undefined : onClose} />

      <div
        className="relative flex flex-col overflow-hidden"
        style={{
          width: 600,
          maxHeight: "88vh",
          background: "var(--bg-pane)",
          border: "1px solid var(--line)",
          borderRadius: 4,
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{ borderBottom: "1px solid var(--line)" }}
        >
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--fg-faded)", fontSize: 10 }}>//</span>
            <span className="text-[11px] font-medium" style={{ color: "var(--green)", letterSpacing: "0.04em" }}>plan from PRD</span>
          </div>
          <button onClick={onClose} style={{ color: "var(--fg-faded)", lineHeight: 1 }} className="hover:text-white transition-colors">
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4 overflow-y-auto flex-1">

          {/* Source picker */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.markdown,text/markdown,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) loadFromFile(file);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="claw-btn"
              style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}
            >
              <FolderOpen size={10} /> upload file
            </button>

            {examplesLoaded && examples.length > 0 && (
              <>
                <span style={{ color: "var(--fg-faded)", fontSize: 10 }}>or</span>
                <select
                  value=""
                  onChange={(e) => loadExample(e.target.value)}
                  style={{ ...S.input, width: "auto", maxWidth: 240 }}
                >
                  <option value="">choose example…</option>
                  {examples.map((ex) => (
                    <option key={ex.name} value={ex.name}>
                      {ex.title} ({(ex.sizeBytes / 1024).toFixed(1)} KB)
                    </option>
                  ))}
                </select>
              </>
            )}

            {sourceLabel && (
              <span
                className="flex items-center gap-1.5 ml-auto"
                style={{ fontSize: 10, color: "var(--fg-dim)", background: "var(--bg-panel)", border: "1px solid var(--green-line)", borderRadius: 2, padding: "2px 8px" }}
              >
                <span style={{ color: "var(--green)", fontSize: 8 }}>●</span>
                {sourceLabel}
                <button onClick={() => { setPrdText(""); setSourceLabel(null); }} style={{ color: "var(--fg-faded)", display: "flex" }}>
                  <X size={10} />
                </button>
              </span>
            )}
          </div>

          {/* Board target */}
          <div className="flex flex-col gap-2">
            <span style={S.label}>// target board</span>
            <div className="flex gap-4">
              {(["new", "existing"] as const).map((choice) => (
                <label key={choice} className="flex items-center gap-1.5 cursor-pointer" style={{ fontSize: 11, color: boardChoice === choice ? "var(--fg)" : "var(--fg-faded)" }}>
                  <input
                    type="radio"
                    name="boardChoice"
                    checked={boardChoice === choice}
                    onChange={() => setBoardChoice(choice)}
                    disabled={choice === "existing" && boards.length === 0}
                    style={{ accentColor: "var(--green)" }}
                  />
                  {choice === "new" ? "new board" : "existing board"}
                </label>
              ))}
            </div>

            {boardChoice === "new" ? (
              <input
                autoFocus
                placeholder="board name (auto-filled from prd title)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={S.input}
              />
            ) : (
              <select value={selectedBoardId} onChange={(e) => setSelectedBoardId(e.target.value)} style={S.input}>
                {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            )}
          </div>

          {/* PRD textarea */}
          <label className="flex flex-col gap-1.5 flex-1">
            <div className="flex items-center justify-between">
              <span style={S.label}>// prd content</span>
              {prdText.length > 0 && (
                <span style={{ fontSize: 10, color: "var(--fg-faded)" }} className="tabular-nums">
                  {prdText.length.toLocaleString()} chars
                </span>
              )}
            </div>
            <textarea
              rows={12}
              placeholder="paste a PRD here, or drop a .md / .txt file anywhere…"
              value={prdText}
              onChange={(e) => { setPrdText(e.target.value); if (sourceLabel) setSourceLabel(null); }}
              style={{
                ...S.input,
                resize: "none",
                lineHeight: 1.6,
                padding: "8px",
              }}
            />
          </label>

          {error && (
            <p
              className="text-[11px] rounded px-3 py-2"
              style={{ color: "var(--red)", background: "var(--red-dim)", border: "1px solid rgba(255,107,107,0.3)" }}
            >
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{ borderTop: "1px solid var(--line)" }}
        >
          <span style={{ fontSize: 10, color: "var(--fg-faded)" }}>uses claude CLI — no api key needed</span>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={running} className="claw-btn" style={{ fontSize: 10 }}>
              cancel
            </button>
            <button
              onClick={submit}
              disabled={running || !prdText.trim() || (boardChoice === "new" && !newName.trim())}
              className="claw-btn primary"
              style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 5, minWidth: 120, justifyContent: "center", opacity: (running || !prdText.trim() || (boardChoice === "new" && !newName.trim())) ? 0.4 : 1 }}
            >
              {running ? (
                <>
                  <span className="w-3 h-3 rounded-full border-2 animate-spin shrink-0" style={{ borderColor: "var(--green-line)", borderTopColor: "var(--green)" }} />
                  planning…
                </>
              ) : (
                <><Wand2 size={10} /> generate tasks</>
              )}
            </button>
          </div>
        </div>

        {/* Drag overlay */}
        {dragActive && !running && (
          <div
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 pointer-events-none"
            style={{ background: "rgba(5,6,8,0.85)", border: "2px dashed var(--green-line)", borderRadius: 4 }}
          >
            <FileText size={32} style={{ color: "var(--green)" }} />
            <p className="text-[11px] font-medium" style={{ color: "var(--green)" }}>drop to load prd</p>
            <p style={{ fontSize: 10, color: "var(--fg-faded)" }}>.md · .txt · .markdown</p>
          </div>
        )}

        {/* Running overlay */}
        {running && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10"
            style={{ background: "rgba(5,6,8,0.9)", borderRadius: 4 }}
          >
            <span
              className="w-8 h-8 rounded-full border-2 animate-spin"
              style={{ borderColor: "var(--green-line)", borderTopColor: "var(--green)" }}
            />
            <div className="text-center">
              <p className="text-[11px] font-medium" style={{ color: "var(--green)" }}>generating task graph…</p>
              <p style={{ fontSize: 10, color: "var(--fg-faded)", marginTop: 4 }}>claude is analysing your prd</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
