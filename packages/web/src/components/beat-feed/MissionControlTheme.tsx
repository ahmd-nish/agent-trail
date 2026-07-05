import { useEffect, useRef } from "react";
import { BeatCard } from "./BeatCard.tsx";
import type { ThemeRendererProps } from "./themes.ts";

// PRD_FEED_EXPERIENCE §3a — Mission Control theme (default, calm, professional).
// Every semantic beat rendered as a BeatCard; mood tints the container edge.
// This is the theme in every README screenshot.

export function MissionControlTheme({ compiled, onScrollStateChange }: ThemeRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      isAtBottomRef.current = atBottom;
      onScrollStateChange?.(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [onScrollStateChange]);

  useEffect(() => {
    if (isAtBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [compiled.beats.length]);

  const moodBorder: Record<typeof compiled.mood, string> = {
    investigating: "var(--blue)",
    building:      "var(--amber)",
    testing:       "var(--purple)",
    stuck:         "var(--red)",
    triumphant:    "var(--green)",
    neutral:       "var(--line)",
  };

  return (
    <div
      ref={containerRef}
      role="list"
      aria-label="Agent activity feed"
      aria-live="polite"
      aria-atomic="false"
      className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-1 font-mono scroll-smooth"
      style={{
        background: "var(--bg)",
        boxShadow: `inset 0 0 0 1px ${moodBorder[compiled.mood]}22`,
        transition: "box-shadow 400ms ease",
      }}
    >
      {compiled.beats.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12">
          <div style={{ fontSize: 12, color: "var(--fg-faded)" }} className="shimmer-text">
            waiting for the first event…
          </div>
        </div>
      ) : (
        compiled.beats.map((b) => <BeatCard key={b.id} beat={b} />)
      )}
    </div>
  );
}
