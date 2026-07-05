import { useState } from "react";
import {
  Terminal, FileText, FileEdit, Search, Globe, Bot, Sparkles, HelpCircle,
  FlaskConical, AlertTriangle, ChevronDown, ChevronRight, Zap, Layers,
} from "lucide-react";
import type { Beat } from "../../lib/beat-compiler.ts";

// A single beat card used by Mission Control (default). Themes can either
// reuse this component or render their own — the beat data is the contract.

const VERB_META: Record<string, { icon: React.ComponentType<{ size?: number }>; color: string; label: string }> = {
  bash:         { icon: Terminal,     color: "var(--fg-dim)",  label: "bash" },
  read:         { icon: FileText,     color: "var(--blue)",    label: "read" },
  write:        { icon: FileEdit,     color: "var(--green)",   label: "write" },
  edit:         { icon: FileEdit,     color: "var(--green)",   label: "edit" },
  grep:         { icon: Search,       color: "var(--purple)",  label: "grep" },
  glob:         { icon: Search,       color: "var(--purple)",  label: "glob" },
  fetch:        { icon: Globe,        color: "var(--blue)",    label: "fetch" },
  search:       { icon: Globe,        color: "var(--blue)",    label: "search" },
  spawn:        { icon: Bot,          color: "var(--purple)",  label: "spawn" },
  ask:          { icon: HelpCircle,   color: "var(--amber)",   label: "ask" },
  test:         { icon: FlaskConical, color: "var(--green)",   label: "test" },
  text:         { icon: Sparkles,     color: "var(--fg-dim)",  label: "text" },
  flurry:       { icon: Zap,          color: "var(--amber)",   label: "flurry" },
  complete:     { icon: Sparkles,     color: "var(--green)",   label: "complete" },
  awaiting_human: { icon: HelpCircle, color: "var(--amber)",   label: "awaiting" },
};

interface Props {
  beat: Beat;
  /** In collapsed mode we render the one-line scannable variant. */
  collapsed?: boolean;
}

export function BeatCard({ beat, collapsed = false }: Props) {
  const [open, setOpen] = useState(false);
  const meta = VERB_META[beat.verb ?? ""] ?? VERB_META["text"]!;
  const Icon = meta.icon;

  if (beat.kind === "chapter" && beat.chapter) {
    return <ChapterHeader chapter={beat.chapter} elapsedMs={beat.detail?.["elapsedMs"] as number | undefined} tokens={beat.detail?.["tokens"] as number | undefined} />;
  }

  if (beat.kind === "text") {
    // Narration bubble.
    return (
      <div className="pl-2 py-1 flex items-start gap-2" role="listitem">
        <Sparkles size={10} className="mt-1 shrink-0" style={{ color: "var(--fg-faded)" }} />
        <div style={{ fontSize: 11, color: "var(--fg-dim)", lineHeight: 1.55, fontStyle: "italic" }}>
          {beat.subject}
        </div>
      </div>
    );
  }

  const outcomeColor =
    beat.outcome === "error" ? "var(--red)"
    : beat.outcome === "ok"  ? "var(--green)"
    : "var(--fg-faded)";

  if (collapsed) {
    return (
      <div
        className="flex items-center gap-2 py-0.5 px-2 rounded"
        role="listitem"
        style={{ fontSize: 11, lineHeight: 1.4 }}
      >
        <Icon size={10} />
        <span style={{ color: meta.color, minWidth: 44 }}>{meta.label}</span>
        <span className="truncate flex-1" style={{ color: "var(--fg)" }}>{beat.subject}</span>
        <OutcomeBadge outcome={beat.outcome} />
      </div>
    );
  }

  const hasMore = Boolean(beat.why) || Boolean(beat.errorHeadline) || Boolean(beat.rawTail) || (beat.members && beat.members.length > 0);

  return (
    <div
      role="listitem"
      className="rounded flex flex-col gap-1 px-2 py-1.5 beat-card"
      style={{
        background: "var(--bg-panel)",
        border: `1px solid ${outcomeColor}44`,
        borderLeftColor: outcomeColor,
        borderLeftWidth: 2,
      }}
    >
      {/* Header row: verb icon + verb + subject + outcome */}
      <div className="flex items-center gap-2 min-w-0">
        <Icon size={11} />
        <span style={{ fontSize: 10, color: meta.color, minWidth: 40, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {meta.label}
        </span>
        <span className="truncate" style={{ fontSize: 12, color: "var(--fg)", fontWeight: 500 }} title={beat.subject}>
          {beat.subject}
        </span>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <MagnitudeBadge beat={beat} />
          <OutcomeBadge outcome={beat.outcome} />
          {hasMore && (
            <button
              onClick={() => setOpen((x) => !x)}
              aria-label={open ? "Collapse details" : "Expand details"}
              style={{ color: "var(--fg-faded)", padding: 0 }}
            >
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          )}
        </div>
      </div>

      {/* Why-line (F1.2) — always visible when present */}
      {beat.why && (
        <div className="pl-6 truncate" style={{ fontSize: 10, color: "var(--fg-faded)", fontStyle: "italic" }}>
          — {beat.why}
        </div>
      )}

      {/* Error headline (F1.5) — headline always visible; raw is inside expand */}
      {beat.errorHeadline && (
        <div className="pl-6 flex items-start gap-1" style={{ fontSize: 11, color: "var(--red)" }}>
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          <span className="truncate" title={beat.errorHeadline}>{beat.errorHeadline}</span>
          {beat.errorClass && (
            <span className="claw-chip red ml-auto" style={{ fontSize: 9 }}>{beat.errorClass}</span>
          )}
        </div>
      )}

      {/* Expanded region */}
      {open && (
        <div className="pl-6 flex flex-col gap-1" style={{ fontSize: 10, color: "var(--fg-dim)" }}>
          {beat.members && beat.members.length > 0 && (
            <div>
              <span style={{ color: "var(--fg-faded)" }}>Members:</span>
              <ul className="mt-0.5 list-disc pl-4" style={{ color: "var(--fg-dim)" }}>
                {beat.members.slice(0, 10).map((m) => (
                  <li key={m.id} className="truncate">{m.verb} · {m.subject}</li>
                ))}
                {beat.members.length > 10 && <li style={{ color: "var(--fg-faded)" }}>…and {beat.members.length - 10} more</li>}
              </ul>
            </div>
          )}
          {beat.rawTail && (
            <pre
              className="whitespace-pre-wrap break-all rounded p-2"
              style={{
                background: "var(--bg-pane)",
                border: "1px solid var(--line)",
                color: "var(--fg-dim)",
                fontSize: 10,
                maxHeight: 200, overflowY: "auto",
              }}
            >
              {beat.rawTail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: Beat["outcome"] }) {
  if (!outcome) return null;
  if (outcome === "pending") return <span style={{ fontSize: 9, color: "var(--fg-faded)" }}>…</span>;
  if (outcome === "ok") return <span style={{ fontSize: 9, color: "var(--green)" }}>✓</span>;
  return <span style={{ fontSize: 9, color: "var(--red)" }}>✗</span>;
}

function MagnitudeBadge({ beat }: { beat: Beat }) {
  const d = beat.detail ?? {};
  if (beat.verb === "bash" && "exitCode" in d) {
    return <span className="claw-chip" style={{ fontSize: 9 }}>exit {d["exitCode"]}</span>;
  }
  if ((beat.verb === "edit" || beat.verb === "write") && (d["added"] || d["removed"])) {
    return (
      <span className="claw-chip" style={{ fontSize: 9 }}>
        <span style={{ color: "var(--green)" }}>+{d["added"] ?? 0}</span>
        {" "}
        <span style={{ color: "var(--red)" }}>−{d["removed"] ?? 0}</span>
      </span>
    );
  }
  if (typeof beat.magnitude === "number" && beat.magnitude > 0) {
    return <span className="claw-chip" style={{ fontSize: 9 }}>{beat.magnitude}</span>;
  }
  return null;
}

function ChapterHeader({ chapter, elapsedMs, tokens }: {
  chapter: NonNullable<Beat["chapter"]>;
  elapsedMs?: number;
  tokens?: number;
}) {
  const meta: Record<typeof chapter, { icon: string; color: string; label: string }> = {
    investigating: { icon: "🔍", color: "var(--blue)",   label: "Investigating" },
    building:      { icon: "🔨", color: "var(--amber)",  label: "Building" },
    testing:       { icon: "🧪", color: "var(--purple)", label: "Testing" },
    verified:      { icon: "✅", color: "var(--green)",  label: "Verified" },
  };
  const m = meta[chapter];
  return (
    <div
      className="flex items-center gap-2 mt-2 mb-1 pl-2 py-0.5 border-l-2"
      style={{ borderColor: m.color }}
    >
      <Layers size={11} style={{ color: m.color }} />
      <span style={{ fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: m.color, fontWeight: 600 }}>
        {m.label}
      </span>
      {(elapsedMs != null || tokens != null) && (
        <span style={{ fontSize: 10, color: "var(--fg-faded)", marginLeft: "auto" }}>
          {elapsedMs != null ? `${(elapsedMs / 1000).toFixed(1)}s` : ""}
          {tokens != null ? ` · ${tokens.toLocaleString()} tok` : ""}
        </span>
      )}
    </div>
  );
}
