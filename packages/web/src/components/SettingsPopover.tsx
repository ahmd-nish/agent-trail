import { useState, useEffect, useRef } from "react";
import { Settings, X } from "lucide-react";
import { useFeedPrefs } from "./feed/useFeedPrefs.ts";
import * as sounds from "../lib/sounds.ts";

export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const { prefs, setPrefs } = useFeedPrefs();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sounds.setEnabled({ tickOnTool: prefs.soundToolTick, ding: prefs.soundCompletion, ask: prefs.soundAskHuman });
    sounds.setVolume(prefs.volume);
  }, [prefs.soundToolTick, prefs.soundCompletion, prefs.soundAskHuman, prefs.volume]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((x) => !x)}
        title="preferences"
        className="claw-btn"
        style={{ padding: "3px 7px", fontSize: 11, ...(open ? { color: "var(--fg)", borderColor: "var(--fg-faded)" } : {}) }}
      >
        <Settings size={12} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-9 z-50 flex flex-col gap-3"
          style={{
            width: 240,
            background: "var(--bg-pane)",
            border: "1px solid var(--line)",
            borderRadius: 4,
            padding: "12px 14px",
          }}
        >
          <div className="flex items-center justify-between">
            <span style={{ fontSize: 10, color: "var(--fg-faded)", letterSpacing: "0.05em", textTransform: "uppercase" as const, fontWeight: 500 }}>
              // preferences
            </span>
            <button onClick={() => setOpen(false)} style={{ color: "var(--fg-faded)", display: "flex" }}>
              <X size={11} />
            </button>
          </div>

          <PrefGroup label="animation">
            <Toggle
              label="typewriter"
              desc="stream text char-by-char"
              value={prefs.typewriter}
              onChange={(v) => setPrefs({ typewriter: v })}
            />
            {prefs.typewriter && (
              <div className="flex items-center gap-2 pl-1">
                <span style={{ fontSize: 10, color: "var(--fg-faded)", width: 40, flexShrink: 0 }}>speed</span>
                <input
                  type="range" min={5} max={100} step={5}
                  value={prefs.typewriterCps}
                  onChange={(e) => setPrefs({ typewriterCps: Number(e.target.value) })}
                  className="flex-1 h-1"
                  style={{ accentColor: "var(--green)" }}
                />
                <span style={{ fontSize: 10, color: "var(--fg-faded)", width: 28, textAlign: "right" }} className="tabular-nums">{prefs.typewriterCps}</span>
              </div>
            )}
            <Toggle
              label="confetti"
              desc="first completion of the day"
              value={prefs.confetti}
              onChange={(v) => setPrefs({ confetti: v })}
            />
          </PrefGroup>

          <PrefGroup label="sound">
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 10, color: "var(--fg-faded)", width: 40, flexShrink: 0 }}>vol</span>
              <input
                type="range" min={0} max={1} step={0.05}
                value={prefs.volume}
                onChange={(e) => setPrefs({ volume: Number(e.target.value) })}
                className="flex-1 h-1"
                style={{ accentColor: "var(--green)" }}
              />
              <span style={{ fontSize: 10, color: "var(--fg-faded)", width: 28, textAlign: "right" }} className="tabular-nums">{Math.round(prefs.volume * 100)}%</span>
            </div>
            <Toggle label="tool tick" desc="click on every tool call" value={prefs.soundToolTick} onChange={(v) => setPrefs({ soundToolTick: v })} />
            <Toggle label="completion ding" desc="3-note chime on finish" value={prefs.soundCompletion} onChange={(v) => setPrefs({ soundCompletion: v })} />
            <Toggle label="ask-human chime" desc="2-note chime on decision" value={prefs.soundAskHuman} onChange={(v) => setPrefs({ soundAskHuman: v })} />
          </PrefGroup>
        </div>
      )}
    </div>
  );
}

function PrefGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2" style={{ borderTop: "1px solid var(--line-dim)", paddingTop: 10 }}>
      <span style={{ fontSize: 10, color: "var(--fg-faded)", letterSpacing: "0.05em", textTransform: "uppercase" as const, fontWeight: 500 }}>{label}</span>
      {children}
    </div>
  );
}

function Toggle({ label, desc, value, onChange }: { label: string; desc: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <div className="flex-1 min-w-0">
        <p style={{ fontSize: 11, color: "var(--fg-dim)" }}>{label}</p>
        <p style={{ fontSize: 10, color: "var(--fg-faded)" }}>{desc}</p>
      </div>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className="shrink-0 rounded-full transition-colors"
        style={{ width: 28, height: 14, background: value ? "var(--green)" : "var(--line)", position: "relative" }}
      >
        <span
          className="block rounded-full transition-transform"
          style={{ width: 10, height: 10, background: "var(--bg-pane)", position: "absolute", top: 2, left: 2, transform: value ? "translateX(14px)" : "translateX(0)" }}
        />
      </button>
    </label>
  );
}
