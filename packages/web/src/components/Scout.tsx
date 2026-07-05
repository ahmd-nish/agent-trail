import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

const DISMISS_KEY = "agent-trail:scout-hidden";

// PRD 1.16 stretch — Scout as a pixel-art walkman mascot with an animated
// LED face. Body: rounded blue box with a black outline + yellow headphones
// (round ears) connected by a black headband — matches the reference art.
// Screen inside cycles per-mood frames. All timings deliberately SLOW so
// expressions read as moods, not twitches.

type Beat =
  | "hello" | "planning" | "running" | "tdd_gate" | "decision" | "resumed" | "credits"
  | "idle" | "empty_board" | "working" | "needs_you" | "celebrating" | "task_error";

type Mood = "neutral" | "thinking" | "processing" | "asking" | "happy" | "error";

const LINES: Record<Beat, { text: string; mood: Mood }> = {
  hello:        { text: "hey — this is a real replay. no api key needed.",           mood: "neutral"    },
  planning:     { text: "the planner turned a PRD into this task graph.",            mood: "thinking"   },
  running:      { text: "claude is running in per-task worktrees, three at a time.", mood: "processing" },
  tdd_gate:     { text: "tests first — nothing ships red.",                          mood: "thinking"   },
  decision:     { text: "your turn — the agent needs a call.",                       mood: "asking"     },
  resumed:      { text: "nice. carrying on with your answer.",                       mood: "happy"      },
  credits:      { text: "run it on your own repo: npx agent-trail",                  mood: "happy"      },
  idle:         { text: "ready when you are.",                                       mood: "neutral"    },
  empty_board:  { text: "drop a PRD or click the sample to get a task graph.",       mood: "neutral"    },
  working:      { text: "on it — running claude in a worktree right now.",           mood: "processing" },
  needs_you:    { text: "a task is awaiting your decision — check the amber card.",  mood: "asking"     },
  celebrating:  { text: "green across the board. nice work.",                        mood: "happy"      },
  task_error:   { text: "a task failed. open the red card to see the last error.",   mood: "error"      },
};

// ─── 8x8 sprite frames per mood ──────────────────────────────────────────────
// Drawn in the chunky pixel-art style of the walkman reference — thick lines,
// expressive shapes that read at a glance.

type Frame = readonly string[];

const NEUTRAL: readonly Frame[] = [
  // Calm open eyes + soft mouth
  [
    "........",
    ".##..##.",
    ".##..##.",
    "........",
    "........",
    "........",
    "..####..",
    "........",
  ],
  // Blink — closed eyes (held briefly)
  [
    "........",
    "........",
    "########",
    "........",
    "........",
    "........",
    "..####..",
    "........",
  ],
];

const THINKING: readonly Frame[] = [
  // Look left — searching
  [
    "........",
    "##...##.",
    "##...##.",
    "........",
    "........",
    "........",
    "..####..",
    "........",
  ],
  // Center
  [
    "........",
    ".##..##.",
    ".##..##.",
    "........",
    "........",
    "........",
    "..####..",
    "........",
  ],
  // Right
  [
    "........",
    ".##...##",
    ".##...##",
    "........",
    "........",
    "........",
    "..####..",
    "........",
  ],
  // Look down — thought landed
  [
    "........",
    "........",
    ".##..##.",
    ".##..##.",
    "........",
    "........",
    "..####..",
    "........",
  ],
];

const PROCESSING: readonly Frame[] = [
  // Slow pulse — outer ring
  [
    "..####..",
    ".#....#.",
    "#......#",
    "#......#",
    "#......#",
    "#......#",
    ".#....#.",
    "..####..",
  ],
  // Contract
  [
    "...##...",
    "..####..",
    ".##..##.",
    "##....##",
    "##....##",
    ".##..##.",
    "..####..",
    "...##...",
  ],
  // Bright center
  [
    "..####..",
    ".######.",
    "########",
    "########",
    "########",
    "########",
    ".######.",
    "..####..",
  ],
  // Contract again
  [
    "...##...",
    "..####..",
    ".##..##.",
    "##....##",
    "##....##",
    ".##..##.",
    "..####..",
    "...##...",
  ],
];

const ASKING: readonly Frame[] = [
  // Wide surprised eyes + O mouth
  [
    "........",
    ".##..##.",
    "####.###",
    "####.###",
    ".##..##.",
    "........",
    "..####..",
    "..####..",
  ],
  // Bigger — gasp
  [
    ".##..##.",
    "########",
    "########",
    "####.###",
    ".##..##.",
    "........",
    "..####..",
    "...##...",
  ],
  // Back to wide
  [
    "........",
    ".##..##.",
    "####.###",
    "####.###",
    ".##..##.",
    "........",
    "..####..",
    "..####..",
  ],
];

const HAPPY: readonly Frame[] = [
  // Reference "happy" — closed crescent eyes ˆ‿ˆ + curved smile
  [
    "........",
    ".##..##.",
    "####.###",
    ".##..##.",
    "........",
    "#......#",
    ".######.",
    "..####..",
  ],
  // Wider grin
  [
    "........",
    ".##..##.",
    "####.###",
    ".##..##.",
    "#......#",
    "#......#",
    ".######.",
    "..####..",
  ],
  // Heart pop
  [
    ".##..##.",
    "########",
    "########",
    ".######.",
    "..####..",
    "...##...",
    "........",
    "..####..",
  ],
  // Back to smile
  [
    "........",
    ".##..##.",
    "####.###",
    ".##..##.",
    "........",
    "#......#",
    ".######.",
    "..####..",
  ],
];

const ERROR: readonly Frame[] = [
  // Reference "angry" — slanted brows + frown (red pixels via mood color)
  [
    "##......",
    ".##..##.",
    "..#.#..#",
    ".#####..",
    "........",
    "..####..",
    ".#....#.",
    "........",
  ],
  // Deeper glare — narrow eyes
  [
    "###.....",
    ".###.###",
    "..#####.",
    "........",
    "........",
    "..####..",
    ".#....#.",
    "........",
  ],
  // Reference "sad" — droopy eyes, frown
  [
    "........",
    ".####.##",
    ".#.##.#.",
    "........",
    "........",
    "..####..",
    ".#....#.",
    "........",
  ],
  // Back to angry
  [
    "##......",
    ".##..##.",
    "..#.#..#",
    ".#####..",
    "........",
    "..####..",
    ".#....#.",
    "........",
  ],
];

interface MoodConfig {
  frames: readonly Frame[];
  /** ms per frame — kept SLOW so expressions read as moods, not twitches. */
  frameMs: number;
  /** Lit-pixel color for this mood. */
  ledColor: string;
  /** Halo behind the walkman for this mood. */
  glowColor: string;
}

const MOODS: Record<Mood, MoodConfig> = {
  //                                              frame ms      LED           halo
  neutral:    { frames: NEUTRAL,    frameMs: 1600, ledColor: "#22d3ee",    glowColor: "rgba(34,211,238,0.30)" },
  thinking:   { frames: THINKING,   frameMs: 1200, ledColor: "#60a5fa",    glowColor: "rgba(96,165,250,0.35)" },
  processing: { frames: PROCESSING, frameMs: 850,  ledColor: "#22d3ee",    glowColor: "rgba(34,211,238,0.50)" },
  asking:     { frames: ASKING,     frameMs: 1100, ledColor: "#facc15",    glowColor: "rgba(250,204,21,0.40)" },
  happy:      { frames: HAPPY,      frameMs: 1000, ledColor: "#5eff9b",    glowColor: "rgba(94,255,155,0.40)" },
  error:      { frames: ERROR,      frameMs: 1400, ledColor: "#f87171",    glowColor: "rgba(248,113,113,0.45)" },
};

// Neutral holds mostly on the open-eye pose with a slow blink flash.
const NEUTRAL_BLINK_EVERY_MS = 5500;

// Slow, meaningful mood transitions — dim → scanline reboot → new mood.
const TRANSITION_MS = 900;

// ─── Component ───────────────────────────────────────────────────────────────

interface Props { beat: Beat }

export function Scout({ beat }: Props) {
  const [bubbleKey, setBubbleKey] = useState(0);
  const [frameIdx, setFrameIdx] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });
  const line = LINES[beat];
  const prevMood = useRef<Mood>(line.mood);

  useEffect(() => {
    setBubbleKey((k) => k + 1);
    setFrameIdx(0);
  }, [beat]);

  useEffect(() => {
    if (prevMood.current === line.mood) return;
    prevMood.current = line.mood;
    setTransitioning(true);
    const t = setTimeout(() => setTransitioning(false), TRANSITION_MS);
    return () => clearTimeout(t);
  }, [line.mood]);

  useEffect(() => {
    if (transitioning) return;
    const cfg = MOODS[line.mood];

    if (line.mood === "neutral") {
      // Long blink cadence — most of the loop is frame 0.
      const id = setInterval(() => {
        setFrameIdx(1);
        setTimeout(() => setFrameIdx(0), 260);
      }, NEUTRAL_BLINK_EVERY_MS);
      return () => clearInterval(id);
    }

    const id = setInterval(() => {
      setFrameIdx((i) => (i + 1) % cfg.frames.length);
    }, cfg.frameMs);
    return () => clearInterval(id);
  }, [line.mood, transitioning]);

  function dismiss() {
    setHidden(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
  }

  if (hidden) return null;

  const cfg = MOODS[line.mood];
  const frame = cfg.frames[frameIdx] ?? cfg.frames[0]!;

  return (
    <div
      className="fixed bottom-6 left-6 z-[60] flex items-center gap-3"
      data-testid="scout-mascot"
    >
      <Walkman frame={frame} cfg={cfg} dimmed={transitioning} dismiss={dismiss} />

      {line.text && (
        <div
          key={bubbleKey}
          className="rounded-lg px-3 py-2 max-w-xs scout-bubble-pop"
          style={{
            background: "var(--bg-pane)",
            border: `1.5px solid ${cfg.ledColor}`,
            color: "var(--fg)",
            fontSize: 12,
            lineHeight: 1.4,
            fontWeight: 500,
            boxShadow: `0 4px 20px rgba(0,0,0,0.4), 0 0 12px ${cfg.ledColor}44`,
            // Nudge 3px below Scout's centerline — reads better with the face
            // than dead-centered because the mouth sits slightly below center.
            transform: "translateY(3px)",
            transition: `border-color ${TRANSITION_MS}ms ease, box-shadow ${TRANSITION_MS}ms ease`,
          }}
        >
          {line.text}
        </div>
      )}
    </div>
  );
}

// ─── Walkman body — matches the reference art ────────────────────────────────

function Walkman({ frame, cfg, dimmed, dismiss }: {
  frame: Frame;
  cfg: MoodConfig;
  dimmed: boolean;
  dismiss: () => void;
}) {
  // Overall footprint stays close to the previous 56×56 — the blue body is
  // 50×46, tiny yellow ears + headband on top add a few pixels each side.
  // Every number below is the previous size × 1.15 (rounded). The mascot
  // stays perfectly proportional — bumping just the wrapper via transform
  // would misalign the bubble, so we scale in real pixels instead.
  return (
    <div
      className="relative shrink-0 scout-float"
      style={{
        width: 76,
        height: 71,
        filter: `drop-shadow(0 7px 16px rgba(0,0,0,0.5)) drop-shadow(0 0 18px ${cfg.glowColor})`,
        transition: `filter ${TRANSITION_MS}ms ease`,
      }}
    >
      {/* Headband — thick black arc over the top */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 5, left: 12, right: 12,
          height: 14,
          border: "3px solid #0b0b0f",
          borderBottom: "none",
          borderRadius: "21px 21px 0 0",
        }}
      />

      {/* Left ear (yellow disc) */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 28,
          width: 14, height: 18,
          background: "#f2c435",
          border: "2px solid #0b0b0f",
          borderRadius: 3,
          boxShadow: "inset -2px 0 0 rgba(0,0,0,0.18)",
        }}
      />
      {/* Right ear */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: 0,
          top: 28,
          width: 14, height: 18,
          background: "#f2c435",
          border: "2px solid #0b0b0f",
          borderRadius: 3,
          boxShadow: "inset 2px 0 0 rgba(0,0,0,0.18)",
        }}
      />

      {/* Main body — chunky blue rounded rect */}
      <div
        style={{
          position: "absolute",
          left: 9, right: 9,
          top: 16, bottom: 0,
          background: "linear-gradient(180deg, #3b70d9 0%, #274ea3 60%, #1c3c85 100%)",
          border: "2.5px solid #0b0b0f",
          borderRadius: 9,
          boxShadow: "inset 2px 2px 0 rgba(255,255,255,0.14), inset -2px -2px 0 rgba(0,0,0,0.28)",
          padding: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* LED screen — black inset rectangle */}
        <div
          style={{
            width: "100%",
            height: "100%",
            background: "#080c08",
            border: "2px solid #050505",
            borderRadius: 3,
            display: "grid",
            gridTemplateColumns: "repeat(8, 1fr)",
            gridTemplateRows: "repeat(8, 1fr)",
            gap: 1,
            padding: 2,
            position: "relative",
            overflow: "hidden",
            boxShadow: `inset 0 0 7px ${cfg.ledColor}22, inset 0 1px 2px rgba(0,0,0,0.9)`,
          }}
        >
          {renderPixels(frame, cfg.ledColor, dimmed)}
          {dimmed && (
            <span
              aria-hidden
              className="scout-scanline"
              style={{ background: cfg.ledColor }}
            />
          )}
        </div>
      </div>

      {/* Dismiss button — hidden until hover */}
      <button
        onClick={dismiss}
        aria-label="Hide Scout"
        className="scout-dismiss"
        style={{
          position: "absolute", top: -7, right: -7,
          width: 21, height: 21,
          background: "var(--bg-pane)",
          border: `1px solid ${cfg.ledColor}`,
          color: cfg.ledColor,
          borderRadius: "50%",
          cursor: "pointer",
          opacity: 0,
          transition: "opacity 150ms",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <X size={12} strokeWidth={2.5} />
      </button>
    </div>
  );
}

function renderPixels(frame: Frame, color: string, dimmed: boolean) {
  const dots: React.ReactNode[] = [];
  for (let y = 0; y < 8; y++) {
    const row = frame[y] ?? "........";
    for (let x = 0; x < 8; x++) {
      const on = row[x] === "#";
      const opacity = dimmed ? (on ? 0.12 : 0) : 1;
      dots.push(
        <span
          key={`${x}-${y}`}
          style={{
            width: "100%", height: "100%",
            borderRadius: 1, // chunky pixel look
            background: on ? color : "transparent",
            boxShadow: on ? `0 0 2px ${color}, 0 0 4px ${color}88` : "none",
            opacity,
            // Slow crossfade so frame swaps read as smooth transitions.
            transition: "background-color 380ms ease, box-shadow 380ms ease, opacity 380ms ease",
          }}
        />,
      );
    }
  }
  return dots;
}

export type ScoutBeat = Beat;
