import { useRef, useState, useEffect, useMemo } from "react";
import { ChevronDown, Clapperboard } from "lucide-react";
import type { UiEvent } from "../../lib/api.ts";
import { processEvents } from "./types.ts";
import { EventCard } from "./EventCard.tsx";
import { useFeedPrefs } from "./useFeedPrefs.ts";

interface Props {
  events: UiEvent[];
  /** When true (task is still running) the last text block will typewrite. */
  isRunning?: boolean;
  className?: string;
}

export function Feed({ events, isRunning = false, className = "" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showJumpPill, setShowJumpPill] = useState(false);

  const { prefs } = useFeedPrefs();

  const items = useMemo(() => processEvents(events), [events]);

  // The last text item's index — only that one animates while running.
  const lastTextIdx = (() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === "text") return i;
    }
    return -1;
  })();

  // Track whether user has scrolled up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      isAtBottomRef.current = atBottom;
      setShowJumpPill(!atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll to bottom on new items — but only if already near the bottom.
  useEffect(() => {
    if (isAtBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [items.length]);

  function jumpToLatest() {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" });
    isAtBottomRef.current = true;
    setShowJumpPill(false);
  }

  return (
    <div className={`relative flex flex-col overflow-hidden ${className}`}>
      <div
        ref={containerRef}
        role="list"
        aria-label="Agent activity feed"
        aria-live="polite"
        aria-atomic="false"
        className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-1.5 font-mono text-[12px] leading-relaxed bg-slate-950 scroll-smooth"
      >
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-12 text-amber-500/80">
            <Clapperboard size={40} className="animate-bounce text-amber-400" aria-hidden="true" />
            <p className="text-sm font-semibold shimmer-text">Spinning up the agent…</p>
            <p className="text-xs text-amber-500/50">Waiting for the first event from Claude.</p>
          </div>
        ) : (
          items.map((item, i) => (
            <EventCard
              key={item.id}
              item={item}
              animateText={isRunning && prefs.typewriter && i === lastTextIdx}
              typewriterCps={prefs.typewriterCps}
            />
          ))
        )}
      </div>

      {showJumpPill && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none">
          <button
            onClick={jumpToLatest}
            className="pointer-events-auto pill-enter flex items-center gap-1.5 px-3 py-1.5 bg-slate-700/90 text-slate-200 text-[11px] rounded-full shadow-lg hover:bg-slate-600 transition-colors border border-slate-600 backdrop-blur-sm"
          >
            <ChevronDown size={11} aria-hidden="true" />
            Jump to latest
          </button>
        </div>
      )}
    </div>
  );
}
