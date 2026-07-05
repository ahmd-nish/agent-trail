import { useState, useRef, useEffect } from "react";
import { Settings, AlertTriangle } from "lucide-react";
import type { Board, AgentKind, ReviewKind, PermissionMode } from "../../../core/src/types/index.ts";
import { api } from "../lib/api.ts";
import { BoardEnvEditor } from "./BoardEnvEditor.tsx";

interface Props {
  board: Board;
  onUpdated: (board: Board) => void;
}

const AGENTS: AgentKind[] = ["claude-code", "codex", "gemini", "custom"];
const REVIEW_KINDS: ReviewKind[] = ["none", "automated", "browser", "human"];
const REVIEW_LABELS: Record<ReviewKind, string> = {
  none: "none", automated: "automated", browser: "browser (mcp)", human: "human",
};
const PERMISSION_MODES: PermissionMode[] = ["acceptEdits", "default", "plan", "bypassPermissions"];
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  acceptEdits: "acceptEdits — auto-approve file edits",
  default: "default — prompt on each tool call",
  plan: "plan — read-only, no edits",
  bypassPermissions: "bypassPermissions — DANGEROUS",
};
const BYPASS_WARNING =
  "Bypass mode lets the agent run any tool — including shell commands and " +
  "git operations — without prompting. Only use this on:\n\n" +
  "  • Disposable repos or worktrees\n" +
  "  • PRDs you trust end-to-end\n" +
  "  • Machines without production credentials\n\nContinue?";

const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--line)",
  color: "var(--fg)",
  fontFamily: "inherit",
  fontSize: 11,
  borderRadius: 2,
  padding: "4px 8px",
  width: "100%",
  outline: "none",
};

export function BoardSettings({ board, onUpdated }: Props) {
  const [open, setOpen] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState(board.webhookUrl ?? "");
  const [defaultModel, setDefaultModel] = useState(board.defaultModel ?? "");
  const [defaultAssignee, setDefaultAssignee] = useState<AgentKind>(board.defaultAssignee);
  const [defaultReviewKind, setDefaultReviewKind] = useState<ReviewKind>(board.defaultReviewKind);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(board.permissionMode);
  const [implementationDir, setImplementationDir] = useState(board.implementationDir ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setWebhookUrl(board.webhookUrl ?? "");
    setDefaultModel(board.defaultModel ?? "");
    setDefaultAssignee(board.defaultAssignee);
    setDefaultReviewKind(board.defaultReviewKind);
    setPermissionMode(board.permissionMode);
    setImplementationDir(board.implementationDir ?? "");
    setSaved(false);
  }, [board.id, board.webhookUrl, board.defaultModel, board.defaultAssignee, board.defaultReviewKind, board.permissionMode, board.implementationDir]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  async function save() {
    setSaving(true);
    try {
      const updated = await api.boards.update(board.id, {
        webhookUrl: webhookUrl.trim() || null,
        defaultModel: defaultModel.trim() || null,
        defaultAssignee,
        defaultReviewKind,
        permissionMode,
        implementationDir: implementationDir.trim() || null,
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
        title="board settings"
        className="claw-btn"
        style={{ padding: "3px 7px", fontSize: 11, ...(open ? { color: "var(--fg)", borderColor: "var(--fg-faded)" } : {}) }}
      >
        <Settings size={12} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-9 z-30 flex flex-col gap-3"
          style={{
            width: 300,
            background: "var(--bg-pane)",
            border: "1px solid var(--line)",
            borderRadius: 4,
            padding: "12px 14px",
          }}
        >
          <SectionHeader label="// board settings" />

          <Group label="task defaults">
            <Field label="default model">
              <input
                placeholder="claude-opus-4-7 (blank = latest)"
                value={defaultModel}
                onChange={(e) => { setDefaultModel(e.target.value); setSaved(false); }}
                style={inputStyle}
              />
            </Field>

            <Field label="default assignee">
              <select value={defaultAssignee} onChange={(e) => { setDefaultAssignee(e.target.value as AgentKind); setSaved(false); }} style={inputStyle}>
                {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </Field>

            <Field label="default review kind">
              <select value={defaultReviewKind} onChange={(e) => { setDefaultReviewKind(e.target.value as ReviewKind); setSaved(false); }} style={inputStyle}>
                {REVIEW_KINDS.map((k) => <option key={k} value={k}>{REVIEW_LABELS[k]}</option>)}
              </select>
            </Field>
          </Group>

          <Group label="implementation directory">
            <Field label="where claude writes code">
              <input
                placeholder="~/agent-trail-runs/<board>"
                value={implementationDir}
                onChange={(e) => { setImplementationDir(e.target.value); setSaved(false); }}
                style={{ ...inputStyle }}
              />
              <p style={{ fontSize: 10, color: "var(--fg-faded)", marginTop: 3 }}>
                absolute path — cwd for every task. blank resets to default.
              </p>
            </Field>
          </Group>

          <Group label="execution permissions">
            <Field label="permission mode">
              <select
                value={permissionMode}
                onChange={(e) => {
                  const next = e.target.value as PermissionMode;
                  if (next === "bypassPermissions" && permissionMode !== "bypassPermissions") {
                    if (!confirm(BYPASS_WARNING)) return;
                  }
                  setPermissionMode(next);
                  setSaved(false);
                }}
                style={inputStyle}
              >
                {PERMISSION_MODES.map((m) => <option key={m} value={m}>{PERMISSION_LABELS[m]}</option>)}
              </select>
              <p style={{ fontSize: 10, color: "var(--fg-faded)", marginTop: 3 }}>
                passed to <code>claude --permission-mode</code>
              </p>
              {permissionMode === "bypassPermissions" && (
                <p className="flex items-center gap-1" style={{ fontSize: 10, color: "var(--amber)", marginTop: 3 }}>
                  <AlertTriangle size={9} /> bypass mode active — no prompts
                </p>
              )}
            </Field>
          </Group>

          <Group label="environment">
            <BoardEnvEditor boardId={board.id} />
          </Group>

          <Group label="notifications">
            <Field label="webhook url">
              <input
                placeholder="https://hooks.slack.com/…"
                value={webhookUrl}
                onChange={(e) => { setWebhookUrl(e.target.value); setSaved(false); }}
                onKeyDown={(e) => e.key === "Enter" && save()}
                style={inputStyle}
              />
              <p style={{ fontSize: 10, color: "var(--fg-faded)", marginTop: 3 }}>
                fires on task complete, failed, or awaiting decision
              </p>
            </Field>
          </Group>

          <div className="flex items-center justify-between pt-1" style={{ borderTop: "1px solid var(--line-dim)" }}>
            {saved
              ? <span style={{ fontSize: 10, color: "var(--green)" }}>saved</span>
              : <span />
            }
            <button onClick={save} disabled={saving} className="claw-btn primary" style={{ fontSize: 10 }}>
              {saving ? "saving…" : "save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="text-[11px] font-medium" style={{ color: "var(--fg-dim)" }}>{label}</p>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2" style={{ borderTop: "1px solid var(--line-dim)", paddingTop: 10 }}>
      <p style={{ fontSize: 10, color: "var(--fg-faded)", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500 }}>
        {label}
      </p>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span style={{ fontSize: 10, color: "var(--fg-faded)" }}>{label}</span>
      {children}
    </div>
  );
}
