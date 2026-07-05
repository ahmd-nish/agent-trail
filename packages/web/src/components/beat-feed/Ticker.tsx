import { AlertTriangle, Sparkles } from "lucide-react";
import type { CompiledFeed } from "../../lib/beat-compiler.ts";

// PRD_FEED_EXPERIENCE F1.6 — sticky one-line outcome ticker.
// Shows: latest narration excerpt · current chapter · elapsed · counts.

interface Props {
  compiled: CompiledFeed;
  isRunning: boolean;
}

export function Ticker({ compiled, isRunning }: Props) {
  const { beats, mood, stats } = compiled;

  // Latest narration (verb === "text") — closest running commentary.
  const lastText = [...beats].reverse().find((b) => b.verb === "text");
  // Latest chapter marker.
  const chapter = stats.currentChapter ?? "investigating";

  const chapterMeta: Record<typeof chapter, { color: string; label: string; icon: string }> = {
    investigating: { color: "var(--blue)",   label: "Investigating", icon: "🔍" },
    building:      { color: "var(--amber)",  label: "Building",      icon: "🔨" },
    testing:       { color: "var(--purple)", label: "Testing",       icon: "🧪" },
    verified:      { color: "var(--green)",  label: "Verified",      icon: "✅" },
  };
  const cm = chapterMeta[chapter];

  const moodColor: Record<typeof mood, string> = {
    investigating: "var(--blue)",
    building:      "var(--amber)",
    testing:       "var(--purple)",
    stuck:         "var(--red)",
    triumphant:    "var(--green)",
    neutral:       "var(--fg-faded)",
  };

  return (
    <div
      className="ticker-bar flex items-center gap-3 px-3 py-1.5"
      style={{
        borderBottom: `1px solid ${moodColor[mood]}44`,
        background: "var(--bg-pane)",
        fontSize: 11,
        color: "var(--fg-dim)",
        boxShadow: `inset 0 -1px 0 ${moodColor[mood]}22`,
        transition: "border-color 400ms ease, box-shadow 400ms ease",
      }}
    >
      <span className="flex items-center gap-1.5 shrink-0" style={{ color: cm.color, fontWeight: 600 }}>
        <span aria-hidden>{cm.icon}</span>
        <span style={{ letterSpacing: 0.4, textTransform: "uppercase", fontSize: 10 }}>{cm.label}</span>
      </span>
      <span className="text-[10px] shrink-0" style={{ color: "var(--fg-faded)" }}>
        {(stats.elapsedMs / 1000).toFixed(1)}s
      </span>
      <span className="text-[10px] shrink-0 flex items-center gap-1">
        <span style={{ color: "var(--green)" }}>✓{stats.successes}</span>
        <span style={{ color: "var(--red)" }}>✗{stats.errors}</span>
        <span style={{ color: "var(--fg-faded)" }}>tools:{stats.toolCalls}</span>
      </span>

      <span
        className="truncate flex-1 min-w-0 italic"
        style={{ color: "var(--fg-dim)" }}
        title={lastText?.subject}
      >
        {lastText?.subject ? (
          <>
            <Sparkles size={9} className="inline mr-1" style={{ color: "var(--fg-faded)" }} />
            {lastText.subject}
          </>
        ) : isRunning ? "…" : "no activity"}
      </span>

      {mood === "stuck" && (
        <span className="claw-chip red flex items-center gap-1 shrink-0" style={{ fontSize: 9 }}>
          <AlertTriangle size={9} /> stuck
        </span>
      )}
    </div>
  );
}
