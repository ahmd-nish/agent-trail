import { useEffect, useMemo, useRef, useState } from "react";
import { BeatCard } from "./BeatCard.tsx";
import { MatrixRain } from "./MatrixRain.tsx";
import type { ThemeRendererProps } from "./themes.ts";
import type { Beat } from "../../lib/beat-compiler.ts";

// PRD_FEED_EXPERIENCE §3b — Matrix theme.
//   • Falling glyph rain behind (mood-tinted)
//   • Phosphor CRT treatment on the feed panel (scanlines + glow + barrel)
//   • Milestone glyph coalescence overlay
//   • Beat subjects "decrypt" on entry — scrambled → real (150ms)

const MILESTONE_KINDS: Array<Beat["kind"]> = ["test_result", "meta"];
const MILESTONE_MESSAGES: Record<string, string> = {
  test_ok:    "TESTS GREEN",
  test_fail:  "TESTS RED",
  complete:   "TASK COMPLETE",
  awaiting:   "HUMAN NEEDED",
};

export function MatrixTheme({ compiled, onScrollStateChange }: ThemeRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [milestone, setMilestone] = useState<string | null>(null);
  const lastKindRef = useRef<string>("");

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

  // Milestone detection — fires an overlay when a test_result / execution_complete
  // beat is the newest one.
  useEffect(() => {
    const last = compiled.beats.at(-1);
    if (!last || !MILESTONE_KINDS.includes(last.kind)) return;
    const key =
      last.kind === "test_result" ? (last.outcome === "ok" ? "test_ok" : "test_fail") :
      last.verb === "complete"    ? "complete" :
      last.verb === "awaiting_human" ? "awaiting" : "";
    if (!key || key === lastKindRef.current) return;
    lastKindRef.current = key;
    setMilestone(MILESTONE_MESSAGES[key] ?? "");
    const t = setTimeout(() => setMilestone(null), 1500);
    return () => clearTimeout(t);
  }, [compiled.beats]);

  return (
    <div
      className="relative flex-1 flex flex-col matrix-crt"
      style={{ background: "#000", overflow: "hidden" }}
    >
      <MatrixRain mood={compiled.mood} active />

      <div
        ref={containerRef}
        role="list"
        aria-label="Agent activity feed (Matrix theme)"
        className="relative flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-1 font-mono scroll-smooth"
        style={{ zIndex: 1 }}
      >
        {compiled.beats.length === 0 ? (
          <div className="text-center" style={{ color: "#3fbf7f", fontSize: 12, fontFamily: "monospace" }}>
            &gt; awaiting stream…
          </div>
        ) : (
          compiled.beats.map((b) => (
            <div key={b.id} className="matrix-decrypt">
              <BeatCard beat={b} />
            </div>
          ))
        )}
      </div>

      {milestone && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none matrix-milestone"
          style={{ zIndex: 2 }}
          aria-hidden
        >
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 42,
              fontWeight: 700,
              letterSpacing: 4,
              color: "#facc15",
              textShadow: "0 0 12px #facc15, 0 0 24px #facc15",
            }}
          >
            {milestone}
          </div>
        </div>
      )}
    </div>
  );
}
