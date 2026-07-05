import { useState, useEffect, useRef } from "react";
import { Check, X } from "lucide-react";
import type { FeedItem } from "./types.ts";
import { getToolConfig } from "./colors.ts";

interface Props {
  item: Extract<FeedItem, { kind: "tool" }>;
}

export function ToolCallCard({ item }: Props) {
  const cfg = getToolConfig(item.tool);
  const mountedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Count-up timer — starts ticking when pending, stops when resolved.
  useEffect(() => {
    if (item.state !== "pending") return;
    mountedAt.current = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - mountedAt.current), 100);
    return () => clearInterval(id);
  }, [item.state, item.tool]);

  const showTimer = item.state === "pending" && elapsed > 3000;

  const borderCls =
    item.state === "success" ? "border-emerald-700/50" :
    item.state === "error"   ? "border-red-700/50" :
    cfg.border;

  return (
    <div
      className={`log-line-enter flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition-all duration-300 ${cfg.bg} ${borderCls} ${cfg.glow ? "ask-human-glow" : ""}`}
      role="listitem"
    >
      <cfg.Icon size={13} className={`shrink-0 ${cfg.color}`} aria-hidden="true" />
      <span className={`font-semibold text-[11px] font-mono ${cfg.color}`}>{item.tool}</span>

      <div className="ml-auto flex items-center gap-2">
        {item.state === "pending" && (
          <>
            {showTimer && (
              <span className="text-[10px] text-slate-500 tabular-nums">{(elapsed / 1000).toFixed(1)}s</span>
            )}
            <span className="text-[10px] text-amber-400/70 animate-pulse">running…</span>
          </>
        )}
        {item.state === "success" && (
          <Check size={12} className="text-emerald-400 success-tick-enter" aria-label="succeeded" />
        )}
        {item.state === "error" && (
          <div className="error-shake">
            <X size={12} className="text-red-400" aria-label="errored" />
          </div>
        )}
      </div>
    </div>
  );
}
