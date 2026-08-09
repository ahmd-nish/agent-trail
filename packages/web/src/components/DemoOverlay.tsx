import { useState } from "react";
import { PlayCircle, PauseCircle, FastForward, X, Sparkles } from "lucide-react";
import type { DecisionPause } from "../lib/demo.ts";

type Player = {
  setSpeed: (n: number) => void;
  getSpeed: () => number;
  cancel: () => void;
};

interface Props {
  decision: DecisionPause | null;
  done: boolean;
  player: Player;
  onDecisionAnswered: (answer: string) => void;
}

/**
 * Persistent demo badge + speed controls; also renders the decision-ticket
 * dialog and the end-of-run credits card. PRD 1.12 + CINEMATIC §1.
 */
export function DemoOverlay({ decision, done, player, onDecisionAnswered }: Props) {
  const [speed, setSpeedState] = useState(player.getSpeed());

  function bumpSpeed() {
    const cycle: Record<string, number> = { "1": 2, "2": 4, "4": 1 };
    const next = cycle[String(speed)] ?? 1;
    player.setSpeed(next);
    setSpeedState(next);
  }

  return (
    <>
      {/* Persistent demo badge */}
      <div
        className="fixed top-3 right-3 z-40 flex items-center gap-2 px-3 py-1.5 rounded"
        style={{ background: "var(--bg-panel)", border: "1px solid var(--purple)", color: "var(--purple)", fontSize: 10 }}
      >
        <Sparkles size={11} />
        DEMO REPLAY
        <span style={{ color: "var(--fg-faded)" }}>·</span>
        <button
          onClick={bumpSpeed}
          className="flex items-center gap-1"
          style={{ color: "var(--fg-dim)", cursor: "pointer" }}
          title="Change playback speed"
        >
          <FastForward size={10} />
          {speed}×
        </button>
        <span style={{ color: "var(--fg-faded)" }}>·</span>
        <a
          href={window.location.pathname}
          style={{ color: "var(--fg-faded)", textDecoration: "underline" }}
          title="Exit demo mode"
        >
          exit
        </a>
      </div>

      {/* Decision ticket modal — the interactive moment */}
      {decision && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.5)" }}
        >
          <div
            className="rounded max-w-lg w-full p-5 flex flex-col gap-4"
            style={{ background: "var(--bg-pane)", border: "1px solid var(--amber)", color: "var(--fg)" }}
          >
            <div className="flex items-center gap-2">
              <PauseCircle size={16} style={{ color: "var(--amber)" }} />
              <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--amber)" }}>
                Agent needs a decision
              </span>
            </div>
            <div className="text-[13px] leading-relaxed">{decision.question}</div>
            {decision.context && (
              <div className="text-[11px] leading-relaxed" style={{ color: "var(--fg-dim)" }}>
                {decision.context}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              {decision.options.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => onDecisionAnswered(opt.value)}
                  className="claw-btn primary text-left"
                  style={{ fontSize: 11, padding: "6px 10px" }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="text-[10px]" style={{ color: "var(--fg-faded)" }}>
              // this is what agents do in a real run — pause and ask instead of guess
            </div>
          </div>
        </div>
      )}

      {/* End-of-run "credits" card */}
      {done && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.6)" }}
        >
          <div
            className="rounded max-w-md w-full p-6 flex flex-col gap-4 items-center text-center"
            style={{ background: "var(--bg-pane)", border: "1px solid var(--green)", color: "var(--fg)" }}
          >
            <PlayCircle size={22} style={{ color: "var(--green)" }} />
            <div className="text-[14px] font-medium">This was a demo replay</div>
            <div className="text-[11px] leading-relaxed" style={{ color: "var(--fg-dim)" }}>
              The events you just saw came from a recorded golden run — zero API cost.
              To run inventarium on your own repo:
            </div>
            <div
              className="w-full rounded px-3 py-2 text-[11px] font-mono text-left"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--line)" }}
            >
              npx inventarium
            </div>
            <div className="flex gap-2">
              <a
                href="https://github.com/anthropics/inventarium"
                target="_blank"
                rel="noreferrer"
                className="claw-btn primary"
                style={{ fontSize: 11, padding: "5px 10px" }}
              >
                Star on GitHub
              </a>
              <a
                href={window.location.pathname}
                className="claw-btn"
                style={{ fontSize: 11, padding: "5px 10px" }}
              >
                Exit demo
              </a>
              <button
                onClick={() => window.location.reload()}
                className="claw-btn"
                style={{ fontSize: 11, padding: "5px 10px", display: "flex", alignItems: "center", gap: 4 }}
              >
                <PlayCircle size={11} /> Replay
              </button>
            </div>
            <button
              onClick={() => player.cancel()}
              className="text-[10px] flex items-center gap-1"
              style={{ color: "var(--fg-faded)" }}
            >
              <X size={9} /> dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
}
