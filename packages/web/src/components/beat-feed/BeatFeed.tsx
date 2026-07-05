import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Monitor, Terminal as TerminalIcon, Gamepad2, List, Rows } from "lucide-react";
import type { UiEvent } from "../../lib/api.ts";
import { compileBeats, type BeatMood } from "../../lib/beat-compiler.ts";
import { Ticker } from "./Ticker.tsx";
import { MissionControlTheme } from "./MissionControlTheme.tsx";
import { MatrixTheme } from "./MatrixTheme.tsx";
import { ArcadeTheme } from "./ArcadeTheme.tsx";
import { BeatCard } from "./BeatCard.tsx";
import { loadPersistedTheme, persistTheme, prefersReducedMotion, type ThemeId } from "./themes.ts";

// PRD_FEED_EXPERIENCE — the top-level feed component. Consumers pass raw
// UiEvents; we compile beats and render through the active theme.

interface Props {
  events: UiEvent[];
  isRunning?: boolean;
  className?: string;
  /** Optional prop to force a theme (used by the demo replay). */
  themeOverride?: ThemeId;
}

const THEMES: Array<{ id: ThemeId; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: "mission-control", label: "Mission Control", icon: Monitor },
  { id: "matrix",          label: "Matrix",          icon: TerminalIcon },
  { id: "arcade",          label: "Arcade",          icon: Gamepad2 },
];

export function BeatFeed({ events, isRunning = false, className = "", themeOverride }: Props) {
  const startedAtRef = useRef<number>(Date.now());
  const [theme, setTheme] = useState<ThemeId>(() => themeOverride ?? loadPersistedTheme());
  const [collapsed, setCollapsed] = useState(false);
  const [showJumpPill, setShowJumpPill] = useState(false);

  // If the user set prefers-reduced-motion AND their persisted theme is a
  // busy one, boot them into Mission Control for this session. Don't rewrite
  // their persisted choice — they might want it back with motion re-enabled.
  useEffect(() => {
    if (themeOverride) return;
    if (prefersReducedMotion() && theme !== "mission-control") setTheme("mission-control");
    // Intentionally omit `theme` — this only runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeOverride]);

  const compiled = useMemo(
    () => compileBeats(events, { startedAt: startedAtRef.current }),
    [events],
  );

  function pickTheme(next: ThemeId) {
    setTheme(next);
    persistTheme(next);
  }

  const themeComponent =
    theme === "matrix"           ? <MatrixTheme        compiled={compiled} isRunning={isRunning} onScrollStateChange={(atBottom) => setShowJumpPill(!atBottom)} /> :
    theme === "arcade"           ? <ArcadeTheme        compiled={compiled} isRunning={isRunning} onScrollStateChange={(atBottom) => setShowJumpPill(!atBottom)} /> :
                                   <MissionControlTheme compiled={compiled} isRunning={isRunning} onScrollStateChange={(atBottom) => setShowJumpPill(!atBottom)} />;

  return (
    <div className={`relative flex flex-col overflow-hidden ${className}`}>
      <Ticker compiled={compiled} isRunning={isRunning} />

      {/* Theme + view controls */}
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderBottom: "1px solid var(--line)", background: "var(--bg-pane)" }}>
        <div className="flex items-center gap-0.5 rounded" style={{ background: "var(--bg-panel)", padding: 2, border: "1px solid var(--line)" }}>
          {THEMES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => pickTheme(id)}
              title={label}
              aria-label={`Switch to ${label} theme`}
              className="flex items-center gap-1 px-2 py-0.5 rounded"
              style={{
                fontSize: 10,
                background: theme === id ? "var(--green-line)" : "transparent",
                color: theme === id ? "var(--green)" : "var(--fg-dim)",
              }}
            >
              <Icon size={11} />
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand cards" : "Collapse to timeline"}
            aria-label={collapsed ? "Expand cards" : "Collapse to timeline"}
            className="flex items-center gap-1 px-2 py-0.5 rounded"
            style={{
              fontSize: 10, background: collapsed ? "var(--blue-line)" : "transparent",
              color: collapsed ? "var(--blue)" : "var(--fg-dim)",
              border: "1px solid var(--line)",
            }}
          >
            {collapsed ? <><List size={10} /> timeline</> : <><Rows size={10} /> cards</>}
          </button>
        </div>
      </div>

      {/* Feed content — either the theme renders it, or we render the collapsed timeline. */}
      {collapsed ? (
        <CollapsedTimeline compiled={compiled} />
      ) : (
        themeComponent
      )}

      {showJumpPill && !collapsed && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none z-10">
          <div className="pointer-events-auto pill-enter flex items-center gap-1.5 px-3 py-1.5 rounded-full shadow-lg" style={{ background: "var(--bg-panel)", color: "var(--fg-dim)", fontSize: 11, border: "1px solid var(--line)" }}>
            <ChevronDown size={11} />
            Scroll to latest
          </div>
        </div>
      )}
    </div>
  );
}

// F1.7 — collapsed one-line-per-beat timeline. Every card can still be
// expanded individually by clicking (BeatCard collapsed mode is display-only,
// so we just render the full card conditionally below in a tighter list).
function CollapsedTimeline({ compiled }: { compiled: ReturnType<typeof compileBeats> }) {
  return (
    <div
      role="list"
      aria-label="Collapsed timeline"
      className="flex-1 overflow-y-auto px-3 py-2 flex flex-col font-mono"
      style={{ background: "var(--bg)" }}
    >
      {compiled.beats.map((b) => <BeatCard key={b.id} beat={b} collapsed />)}
    </div>
  );
}

// Re-export for the App to use when picking Scout mood from beat mood, etc.
export type { BeatMood };
