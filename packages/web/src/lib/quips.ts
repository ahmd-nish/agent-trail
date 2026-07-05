// PRD_OPEN_SOURCE 2.10 — Scout v1 joke engine. Deterministic template pack,
// zero LLM. Quips are event-keyed strings with {slot} interpolation; the
// selector picks one per triggered event under a cooldown + no-repeat shuffle,
// respecting a tone gate (playful/dry/off).
//
// Author packs as YAML for community contributions (see docs/quips-pack.md),
// but the built-in pack ships inline as TS so first paint is offline-instant.

export type Tone = "playful" | "dry" | "off";

/** All event keys the engine understands. Beat compiler + App raise these. */
export type QuipEvent =
  | "test_fail_1"          // first red on a task
  | "test_fail_many"       // n>=3 reds on same task
  | "escalation"           // model tier bumped
  | "long_tool_streak"     // n>=6 same-verb tool calls
  | "cost_threshold"       // spend crossed a rounded threshold
  | "milestone"            // done/total ratchets up
  | "idle_board"           // no tasks in flight, board not empty
  | "empty_board"          // no tasks at all
  | "tests_green"          // first green after a red
  | "resumed"              // execution resumed from --resume
  | "budget_tripped"       // cost cap hit → execution killed
  | "decision_ticket"      // ask_human pending
  | "task_completed"       // any task moves to done
  | "task_error";          // task moved to blocked with lastError

export interface QuipSlots {
  taskName?: string;
  n?: number;
  cost?: string;   // pre-formatted, e.g. "$0.20"
  done?: number;
  total?: number;
}

export interface QuipPack {
  /** Tone this pack contributes to. `playful` and `dry` are separate pools;
   *  `off` disables the engine entirely (not a valid pack tone). */
  tone: Extract<Tone, "playful" | "dry">;
  quips: Partial<Record<QuipEvent, readonly string[]>>;
}

// ─── Default pack (playful) ──────────────────────────────────────────────────
// Sourced from CINEMATIC_ENGAGEMENT_SPEC §3 "The joke engine" plus a handful
// of shipping-day extras. All lines must be *observably true* — they only
// appear when the event actually fired, so no fabrication.

export const DEFAULT_PLAYFUL: QuipPack = {
  tone: "playful",
  quips: {
    test_fail_1:      ["red. bold choice. let's see the rewrite.",
                       "one red. every green story starts here."],
    test_fail_many:   ["{taskName}, attempt {n}. i've seen this movie. it ends green.",
                       "{n} reds and counting. character development."],
    escalation:       ["sonnet tapped out. opus is stretching.",
                       "escalating. bigger model, same taste."],
    long_tool_streak: ["that's {n} file reads. somebody's *thorough*.",
                       "{n} tool calls in a row. locked in."],
    cost_threshold:   ["we just passed {cost}. worth it. probably.",
                       "{cost} spent. staying on brand."],
    milestone:        ["{done}/{total} done. the backlog fears you.",
                       "another one down. {done}/{total}."],
    idle_board:       ["it's quiet. suspiciously quiet. drop a PRD in?",
                       "board's napping. what should we build?"],
    empty_board:      ["blank slate. paste a PRD or click the sample.",
                       "an empty board is just a very calm one."],
    tests_green:      ["green. finally. i knew you had it.",
                       "green across the board. take the win."],
    resumed:          ["picked up where we left off.",
                       "back on the trail."],
    budget_tripped:   ["budget cap. we killed it before it killed the wallet.",
                       "hit the cap. graceful stop, no drama."],
    decision_ticket:  ["a task needs your call.",
                       "amber card is waiting on you."],
    task_completed:   ["another one shipped.",
                       "done. next?"],
    task_error:       ["a task went red. check the last error.",
                       "something broke. the card has the trace."],
  },
};

export const DEFAULT_DRY: QuipPack = {
  tone: "dry",
  quips: {
    test_fail_1:      ["test failed.",
                       "red."],
    test_fail_many:   ["{taskName}: {n} failures.",
                       "attempt {n}. still red."],
    escalation:       ["model tier increased.",
                       "escalated."],
    long_tool_streak: ["{n} sequential tool calls."],
    cost_threshold:   ["spend: {cost}."],
    milestone:        ["{done}/{total}."],
    idle_board:       ["idle."],
    empty_board:      ["no tasks."],
    tests_green:      ["tests passing."],
    resumed:          ["resumed."],
    budget_tripped:   ["budget exceeded. execution stopped."],
    decision_ticket:  ["decision required."],
    task_completed:   ["task complete."],
    task_error:       ["task errored."],
  },
};

// ─── Slot fill ───────────────────────────────────────────────────────────────

/** Replace {slot} tokens in `template` with matching values from `slots`.
 *  Missing slots become an empty string — never throw. Public for tests. */
export function fillSlots(template: string, slots: QuipSlots): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = (slots as Record<string, unknown>)[k];
    return v === undefined || v === null ? "" : String(v);
  }).replace(/\s+/g, " ").trim();
}

// ─── Selector engine ─────────────────────────────────────────────────────────

interface EventState {
  /** Indices already emitted this session — reshuffled once every quip runs. */
  used: number[];
  /** Last time (ms epoch) this event fired. */
  lastAt: number;
}

export interface QuipEngineOpts {
  pack?: QuipPack;
  tone?: Tone;
  /** Minimum ms between two firings of the SAME event. Default 8s. */
  perEventCooldownMs?: number;
  /** Minimum ms between ANY two firings — keeps Scout from spamming during
   *  a burst. Default 3.5s. */
  globalCooldownMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable RNG for deterministic tests (0..1). */
  random?: () => number;
}

/**
 * Stateful selector — one instance per session. Not a React hook: keep it
 * plain so the App-level bus can hold a single ref without triggering re-renders
 * on every pick.
 */
export class QuipEngine {
  private pack: QuipPack;
  private tone: Tone;
  private perEventCooldownMs: number;
  private globalCooldownMs: number;
  private now: () => number;
  private random: () => number;
  private state: Map<QuipEvent, EventState> = new Map();
  private lastAnyAt = 0;

  constructor(opts: QuipEngineOpts = {}) {
    this.pack = opts.pack ?? DEFAULT_PLAYFUL;
    this.tone = opts.tone ?? "playful";
    this.perEventCooldownMs = opts.perEventCooldownMs ?? 8_000;
    this.globalCooldownMs   = opts.globalCooldownMs   ?? 3_500;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  setTone(tone: Tone) { this.tone = tone; }
  setPack(pack: QuipPack) { this.pack = pack; this.state.clear(); }
  getTone(): Tone { return this.tone; }

  /**
   * Pick one filled quip for `event`, or null if:
   *   - tone is off, OR
   *   - the event has no lines in the current pack, OR
   *   - per-event or global cooldown is still active.
   * Never throws; safe to call from any event handler.
   */
  pick(event: QuipEvent, slots: QuipSlots = {}): string | null {
    if (this.tone === "off") return null;
    const lines = this.pack.quips[event];
    if (!lines || lines.length === 0) return null;

    const t = this.now();
    if (t - this.lastAnyAt < this.globalCooldownMs) return null;

    const entry = this.state.get(event) ?? { used: [], lastAt: 0 };
    if (entry.lastAt !== 0 && t - entry.lastAt < this.perEventCooldownMs) return null;

    // no-repeat shuffle: once every line's been used, reset the pool.
    const remaining: number[] = [];
    for (let i = 0; i < lines.length; i++) if (!entry.used.includes(i)) remaining.push(i);
    const pool = remaining.length > 0 ? remaining : lines.map((_, i) => i);
    if (remaining.length === 0) entry.used = [];

    const idx = pool[Math.floor(this.random() * pool.length)] ?? pool[0]!;
    entry.used.push(idx);
    entry.lastAt = t;
    this.state.set(event, entry);
    this.lastAnyAt = t;

    return fillSlots(lines[idx]!, slots);
  }

  /** Test helper — clear all cooldown state without changing tone/pack. */
  reset() { this.state.clear(); this.lastAnyAt = 0; }
}

// ─── YAML micro-parser (community packs) ─────────────────────────────────────
// The default packs above ship inline. Community packs can be YAML; we parse
// only the shape:
//
//   tone: playful
//   quips:
//     event_key:
//       - "line one"
//       - "line two"
//
// No anchors, no flow arrays, no comments-inside-strings. Anything more
// exotic → throw with a clear message so a contributor can fix it.

export function parseQuipsYaml(text: string): QuipPack {
  const lines = text.split(/\r?\n/);
  let tone: Tone | undefined;
  const quips: Record<string, string[]> = {};
  let currentEvent: string | null = null;
  let inQuips = false;

  for (let raw of lines) {
    // Strip line-level comments (not inside quoted strings, but our shape
    // doesn't produce those cases so a plain split is fine).
    const hashIdx = raw.indexOf("#");
    if (hashIdx !== -1) {
      const beforeHash = raw.slice(0, hashIdx);
      // Only strip if the # is outside any quote — count quotes.
      const dq = (beforeHash.match(/"/g) || []).length;
      if (dq % 2 === 0) raw = beforeHash;
    }
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;

    // Top-level `tone: playful|dry`
    const toneM = /^tone:\s*(playful|dry)\s*$/.exec(line);
    if (toneM) { tone = toneM[1] as Tone; continue; }

    // `quips:` block start
    if (/^quips:\s*$/.test(line)) { inQuips = true; continue; }
    if (!inQuips) continue;

    // `  event_key:` — 2-space indent under `quips:`
    const evM = /^ {2}([a-z0-9_]+):\s*$/.exec(line);
    if (evM) { currentEvent = evM[1]!; quips[currentEvent] = []; continue; }

    // `    - "line"` — 4-space indent list item under an event
    const itemM = /^ {4}-\s+(.+)\s*$/.exec(line);
    if (itemM && currentEvent) {
      let s = itemM[1]!.trim();
      if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1);
      }
      quips[currentEvent]!.push(s);
      continue;
    }
  }

  if (!tone) throw new Error("quips pack: missing top-level `tone:` (must be playful or dry)");
  return { tone, quips: quips as QuipPack["quips"] };
}
