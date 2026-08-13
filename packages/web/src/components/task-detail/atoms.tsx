import { useState, type ReactNode } from "react";
import {
  Terminal,
  FileText,
  Pencil,
  FileEdit,
  FolderSearch,
  Search,
  Globe,
  Bot,
  ClipboardList,
  BookOpen,
  Settings,
  Rocket,
  Flame,
  Check,
  MessageSquare,
  PartyPopper,
  Skull,
  Hand,
  FlaskConical,
  Siren,
  ArrowRight,
  ArrowLeft,
  ChevronUp,
  ChevronDown,
  Copy,
  type LucideIcon,
} from "lucide-react";
import type { TaskStatus } from "../../../../core/src/types/index.ts";
import type { UiEvent, ArtifactRow } from "../../lib/api.ts";

// ─── Layout primitives ────────────────────────────────────────────────────────

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span
        style={{
          fontSize: 10,
          color: "var(--fg-faded)",
          letterSpacing: "0.05em",
          textTransform: "uppercase" as const,
          fontWeight: 500,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        fontSize: 10,
        color: "var(--fg-faded)",
        letterSpacing: "0.06em",
        textTransform: "uppercase" as const,
        fontWeight: 500,
        marginBottom: 6,
      }}
    >
      {children}
    </p>
  );
}

// ─── Status indicators ────────────────────────────────────────────────────────

const STATUS_COLOR: Record<TaskStatus, string> = {
  backlog: "var(--fg-faded)",
  ready: "var(--blue)",
  in_progress: "var(--green)",
  blocked: "var(--red)",
  in_review: "var(--purple)",
  done: "rgba(94,232,157,0.6)",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span
      className="claw-chip"
      style={{
        color: STATUS_COLOR[status],
        borderColor: `color-mix(in srgb, ${STATUS_COLOR[status]} 30%, transparent)`,
      }}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function StatusDot({ status }: { status: TaskStatus }) {
  return (
    <span
      className="w-1.5 h-1.5 rounded-full shrink-0"
      style={{ background: STATUS_COLOR[status] }}
    />
  );
}

// ─── Metric chip (review mode) ────────────────────────────────────────────────

export function MetricChip({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      className="flex flex-col gap-0.5 px-4 py-3"
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--line)",
        borderRadius: 2,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "var(--fg-faded)",
          letterSpacing: "0.06em",
          textTransform: "uppercase" as const,
        }}
      >
        {label}
      </span>
      <span
        className={`text-lg font-bold ${color}`}
        style={{ fontFamily: "inherit" }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Description as bullets ───────────────────────────────────────────────────

export function DescriptionBullets({ text }: { text: string }) {
  if (!text.trim())
    return (
      <p className="text-sm text-slate-500 italic">No description provided.</p>
    );
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.]+/, "").trim())
    .filter(Boolean);
  if (lines.length === 1) {
    return <p className="text-sm text-slate-200 leading-relaxed">{lines[0]}</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {lines.map((l, i) => (
        <li
          key={i}
          className="flex items-start gap-2.5 text-sm text-slate-200 leading-relaxed"
        >
          <span className="text-slate-500 mt-0.5 shrink-0">•</span>
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── Activity / log lines ─────────────────────────────────────────────────────

/** Tool icon + color palette. Falls back to Settings for unknown tools. */
const TOOL_STYLE: Record<
  string,
  { Icon: LucideIcon; color: string; bg: string }
> = {
  Bash: { Icon: Terminal, color: "text-amber-300", bg: "bg-amber-950/40" },
  Read: { Icon: FileText, color: "text-sky-300", bg: "bg-sky-950/40" },
  Edit: { Icon: Pencil, color: "text-violet-300", bg: "bg-violet-950/40" },
  MultiEdit: { Icon: Pencil, color: "text-violet-300", bg: "bg-violet-950/40" },
  Write: { Icon: FileEdit, color: "text-emerald-300", bg: "bg-emerald-950/40" },
  Glob: { Icon: FolderSearch, color: "text-cyan-300", bg: "bg-cyan-950/40" },
  Grep: { Icon: Search, color: "text-cyan-300", bg: "bg-cyan-950/40" },
  WebFetch: { Icon: Globe, color: "text-indigo-300", bg: "bg-indigo-950/40" },
  WebSearch: { Icon: Globe, color: "text-indigo-300", bg: "bg-indigo-950/40" },
  Task: { Icon: Bot, color: "text-fuchsia-300", bg: "bg-fuchsia-950/40" },
  TodoWrite: {
    Icon: ClipboardList,
    color: "text-yellow-300",
    bg: "bg-yellow-950/40",
  },
  NotebookEdit: {
    Icon: BookOpen,
    color: "text-violet-300",
    bg: "bg-violet-950/40",
  },
};
const DEFAULT_TOOL = {
  Icon: Settings,
  color: "text-slate-300",
  bg: "bg-slate-800/50",
};

export function toolStyle(name: string) {
  // Strip MCP prefix `mcp__<server>__<tool>` to match the bare tool name.
  const bare = name.startsWith("mcp__")
    ? (name.split("__").pop() ?? name)
    : name;
  return TOOL_STYLE[bare] ?? TOOL_STYLE[name] ?? DEFAULT_TOOL;
}

export function LogLine({
  event,
  isLatest = false,
}: {
  event: UiEvent;
  isLatest?: boolean;
}) {
  if (event.type === "connected") {
    const short = event.executionId ? event.executionId.slice(0, 8) : "—";
    return (
      <p className="log-line-enter flex items-center gap-2 text-slate-500">
        <Rocket size={14} className="shrink-0 text-slate-400" />
        <span>
          Connected — session{" "}
          <span className="font-mono text-slate-400">{short}</span>
        </span>
      </p>
    );
  }
  if (event.type === "tool_call") {
    const s = toolStyle(event.tool);
    return (
      <div
        className={`log-line-enter flex items-center gap-2 px-2 py-1 rounded ${s.bg} ${isLatest ? "live-glow" : ""}`}
      >
        <s.Icon size={14} className={`shrink-0 ${s.color}`} />
        <span className={`font-semibold ${s.color}`}>{event.tool}</span>
        {isLatest && (
          <span className="ml-auto text-[10px] text-amber-400/70 animate-pulse">
            running…
          </span>
        )}
      </div>
    );
  }
  if (event.type === "tool_result") {
    return (
      <p
        className={`log-line-enter flex items-center gap-2 pl-3 ${event.isError ? "text-red-400" : "text-emerald-500/80"}`}
      >
        {event.isError ? (
          <Flame size={13} className="shrink-0" />
        ) : (
          <Check size={13} className="shrink-0" />
        )}
        <span className="text-[11px]">
          {event.isError ? "errored" : "done"}
        </span>
      </p>
    );
  }
  if (event.type === "text") {
    return (
      <div className="log-line-enter flex items-start gap-2">
        <MessageSquare size={13} className="shrink-0 text-slate-500 mt-0.5" />
        <p className="text-slate-300 whitespace-pre-wrap leading-relaxed flex-1 italic">
          {event.text}
        </p>
      </div>
    );
  }
  if (event.type === "execution_complete") {
    const ok = event.status === "completed";
    return (
      <div
        className={`log-line-enter font-semibold mt-2 px-3 py-2 rounded-lg border flex items-center gap-2 ${
          ok
            ? "border-emerald-700/50 bg-emerald-950/40 text-emerald-300"
            : "border-red-700/50 bg-red-950/40 text-red-300"
        }`}
      >
        {ok ? (
          <PartyPopper size={15} className="shrink-0" />
        ) : (
          <Skull size={15} className="shrink-0" />
        )}
        {ok ? "Task complete — all done!" : "Execution failed"}
      </div>
    );
  }
  if (event.type === "awaiting_human") {
    return (
      <div className="log-line-enter font-semibold mt-2 px-3 py-2 rounded-lg border border-amber-700/50 bg-amber-950/40 text-amber-300 flex items-center gap-2">
        <Hand size={15} className="shrink-0" />
        Claude needs a human decision — scroll down to answer.
      </div>
    );
  }
  if (event.type === "test_result") {
    return (
      <div
        className={`log-line-enter font-semibold px-3 py-1.5 rounded flex items-center gap-2 ${
          event.passed
            ? "bg-emerald-950/40 text-emerald-300"
            : "bg-red-950/40 text-red-300"
        }`}
      >
        {event.passed ? (
          <FlaskConical size={14} className="shrink-0" />
        ) : (
          <Siren size={14} className="shrink-0" />
        )}
        Tests {event.passed ? "passed" : `failed (exit ${event.exitCode})`}
      </div>
    );
  }
  return null;
}

export function ActivityLine({ event }: { event: UiEvent }) {
  if (event.type === "connected")
    return (
      <p className="text-[11px] text-slate-500">
        Connected — {event.executionId.slice(0, 8)}
      </p>
    );
  if (event.type === "tool_call")
    return (
      <p className="text-[11px] text-purple-400 flex items-center gap-1">
        <ArrowRight size={10} className="text-slate-500 shrink-0" />
        {event.tool}
      </p>
    );
  if (event.type === "tool_result")
    return (
      <p
        className={`text-[11px] flex items-center gap-1 ${event.isError ? "text-red-400" : "text-slate-500"}`}
      >
        <ArrowLeft size={10} className="shrink-0" />
        {event.isError ? "error" : "ok"}
      </p>
    );
  if (event.type === "text")
    return (
      <p className="text-[11px] text-slate-300 leading-relaxed">{event.text}</p>
    );
  if (event.type === "execution_complete")
    return (
      <p
        className={`text-[11px] font-semibold flex items-center gap-1 ${event.status === "completed" ? "text-emerald-400" : "text-red-400"}`}
      >
        <Check size={10} className="shrink-0" />
        {event.status}
      </p>
    );
  return null;
}

// ─── Artifact / diff viewers ──────────────────────────────────────────────────

const ARTIFACT_LABEL: Record<ArtifactRow["kind"], string> = {
  git_diff: "Git diff",
  test_output: "Test output",
  file_list: "Changed files",
  pr_url: "PR",
  custom: "Artifact",
};

export function ArtifactViewer({ artifact }: { artifact: ArtifactRow }) {
  const [expanded, setExpanded] = useState(false);

  const baseStyle: React.CSSProperties = {
    background: "var(--bg-panel)",
    border: "1px solid var(--line)",
    borderRadius: 2,
  };

  if (artifact.kind === "pr_url") {
    return (
      <div className="px-3 py-2 text-[11px]" style={baseStyle}>
        pr: <span style={{ color: "var(--blue)" }}>{artifact.content}</span>
      </div>
    );
  }
  if (artifact.kind === "file_list") {
    return (
      <div className="px-3 py-2" style={baseStyle}>
        <p className="text-[10px] mb-1" style={{ color: "var(--fg-faded)" }}>
          {ARTIFACT_LABEL[artifact.kind]}
        </p>
        <pre
          className="text-[11px] whitespace-pre-wrap"
          style={{ color: "var(--fg-dim)", fontFamily: "inherit" }}
        >
          {artifact.content}
        </pre>
      </div>
    );
  }
  return (
    <div style={{ ...baseStyle, overflow: "hidden" }}>
      <button
        onClick={() => setExpanded((x) => !x)}
        className="w-full text-left px-3 py-2 flex items-center justify-between transition-colors"
        style={{ fontFamily: "inherit", background: expanded ? "var(--bg-panel)" : "transparent" }}
      >
        <span className="text-[11px]" style={{ color: "var(--fg-dim)" }}>
          {ARTIFACT_LABEL[artifact.kind]}
        </span>
        <span className="text-[10px] flex items-center gap-1" style={{ color: "var(--fg-faded)" }}>
          {expanded ? <><ChevronUp size={11} /> collapse</> : <><ChevronDown size={11} /> expand</>}
        </span>
      </button>
      {expanded && (
        <div className="max-h-64 overflow-y-auto" style={{ borderTop: "1px solid var(--line)" }}>
          {artifact.kind === "git_diff" ? (
            <DiffViewer content={artifact.content} />
          ) : (
            <pre
              className="text-[11px] p-3 whitespace-pre-wrap"
              style={{ color: "var(--fg-dim)", fontFamily: "inherit" }}
            >
              {artifact.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffViewer({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy diff:", err);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded hover:bg-slate-700/50 transition-colors"
        title="Copy diff to clipboard"
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--line)",
        }}
      >
        {copied ? (
          <Check size={14} className="text-emerald-400" />
        ) : (
          <Copy size={14} style={{ color: "var(--fg-faded)" }} />
        )}
      </button>
      <pre className="text-[11px] font-mono p-3 whitespace-pre-wrap leading-relaxed pr-12">
        {content.split("\n").map((line, i) => {
          const color =
            line.startsWith("+") && !line.startsWith("+++")
              ? "text-emerald-400"
              : line.startsWith("-") && !line.startsWith("---")
                ? "text-red-400"
                : line.startsWith("@@")
                  ? "text-blue-400"
                  : line.startsWith("diff ") || line.startsWith("index ")
                    ? "text-slate-400"
                    : "text-slate-300";
          return (
            <span key={i} className={`block ${color}`}>
              {line || " "}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function fmtDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function fmtTokens(n: number | null): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
