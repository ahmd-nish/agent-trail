import { useEffect, useMemo, useRef, useState } from "react";
import { Shield, Sword, Zap, Trophy } from "lucide-react";
import { BeatCard } from "./BeatCard.tsx";
import type { ThemeRendererProps } from "./themes.ts";
import type { Beat } from "../../lib/beat-compiler.ts";

// PRD_FEED_EXPERIENCE §3c — Arcade / Anime theme.
//   • Boss HP bar = failing tests. Fix → HP chip
//   • Combo meter: consecutive OK tool calls, broken by any error
//   • Impact frames: error flash + speed-lines (100ms)
//   • Power-up aura for model escalation (approx via any "opus" mention in beat detail)
//   • Read-only visualization — never affects execution behavior

const IMPACT_MS = 120;

interface Combo {
  count: number;
  best: number;
}

export function ArcadeTheme({ compiled, onScrollStateChange }: ThemeRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [impact, setImpact] = useState<"none" | "hit" | "victory">("none");
  const lastKeyRef = useRef<string>("");

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

  // Boss = worst test_result failCount seen so far in the run. Each new
  // test_result trims that number as tests turn green. Reaches zero → victory.
  const bossHp = useMemo(() => computeBossHp(compiled.beats), [compiled.beats]);
  const combo  = useMemo(() => computeCombo(compiled.beats), [compiled.beats]);

  // Fire impact frames when the newest beat is an error or the boss dies.
  useEffect(() => {
    const last = compiled.beats.at(-1);
    if (!last) return;
    const key = `${last.id}:${last.outcome ?? ""}`;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    if (bossHp.wonThisFrame) {
      setImpact("victory");
      setTimeout(() => setImpact("none"), 900);
    } else if (last.outcome === "error") {
      setImpact("hit");
      setTimeout(() => setImpact("none"), IMPACT_MS);
    }
  }, [compiled.beats, bossHp.wonThisFrame]);

  const opusActive = compiled.beats.some((b) => JSON.stringify(b.detail ?? {}).toLowerCase().includes("opus"));

  return (
    <div className={`relative flex-1 flex flex-col arcade-frame ${impact === "hit" ? "arcade-shake" : ""}`} style={{ background: "#0b0714", overflow: "hidden" }}>
      {/* HUD strip */}
      <div className="flex items-center gap-3 px-3 py-2" style={{ background: "#150c1f", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        {bossHp.max > 0 ? (
          <div className="flex items-center gap-2 flex-1">
            <Shield size={12} color="#ff7676" />
            <span style={{ fontSize: 10, color: "#ff7676", fontWeight: 700, letterSpacing: 0.5 }}>
              BOSS {bossHp.current}/{bossHp.max}
            </span>
            <div className="flex-1 rounded overflow-hidden" style={{ height: 8, background: "#2a1128", border: "1px solid #ff767644" }}>
              <div
                className="h-full arcade-hp-bar"
                style={{
                  width: `${(bossHp.current / bossHp.max) * 100}%`,
                  background: "linear-gradient(90deg,#ff4444,#ff8844)",
                  transition: "width 500ms cubic-bezier(.3,1,.4,1)",
                }}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-1">
            <Trophy size={12} color="#facc15" />
            <span style={{ fontSize: 10, color: "#facc15", fontWeight: 700, letterSpacing: 0.5 }}>NO BOSS ENGAGED</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Zap size={12} color="#facc15" className={combo.count >= 5 ? "arcade-combo-pop" : undefined} />
          <span style={{
            fontSize: 12, color: combo.count >= 5 ? "#facc15" : "#a3a3a3",
            fontWeight: 700, letterSpacing: 0.5,
            textShadow: combo.count >= 10 ? "0 0 8px #facc15" : "none",
          }}>
            ×{combo.count}
          </span>
          <span className="text-[9px]" style={{ color: "#888" }}>best {combo.best}</span>
        </div>

        {opusActive && (
          <div className="arcade-power" style={{
            fontSize: 10, letterSpacing: 1, color: "#facc15", fontWeight: 700,
            padding: "2px 8px", border: "1px solid #facc15", borderRadius: 4,
            textShadow: "0 0 8px #facc15",
          }}>
            <Sword size={10} className="inline mr-1" /> OPUS MODE
          </div>
        )}
      </div>

      {/* Feed */}
      <div
        ref={containerRef}
        role="list"
        aria-label="Agent activity feed (Arcade theme)"
        className="relative flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-1 font-mono scroll-smooth"
      >
        {compiled.beats.length === 0 ? (
          <div className="text-center" style={{ color: "#facc15", fontSize: 12, fontFamily: "monospace" }}>
            » ROUND START — waiting for input…
          </div>
        ) : (
          compiled.beats.map((b) => (
            <div key={b.id} className={b.outcome === "error" ? "arcade-hit" : undefined}>
              <BeatCard beat={b} />
            </div>
          ))
        )}
      </div>

      {impact === "hit"     && <div className="arcade-flash" aria-hidden />}
      {impact === "victory" && <div className="arcade-victory" aria-hidden><div>VICTORY!</div></div>}
    </div>
  );
}

interface BossState { current: number; max: number; wonThisFrame: boolean }

function computeBossHp(beats: readonly Beat[]): BossState {
  let max = 0;
  let current = 0;
  let wonThisFrame = false;
  let prevCurrent = 0;
  for (const b of beats) {
    if (b.kind === "test_result") {
      const fail = b.failCount ?? (b.outcome === "error" ? 1 : 0);
      if (fail > max) max = fail;
      current = fail;
      if (prevCurrent > 0 && current === 0) wonThisFrame = true;
      prevCurrent = current;
    }
  }
  return { current, max, wonThisFrame };
}

function computeCombo(beats: readonly Beat[]): Combo {
  let count = 0, best = 0;
  for (const b of beats) {
    if (b.kind !== "tool" && b.kind !== "test_result") continue;
    if (b.outcome === "ok") { count++; if (count > best) best = count; }
    else if (b.outcome === "error") count = 0;
  }
  return { count, best };
}
