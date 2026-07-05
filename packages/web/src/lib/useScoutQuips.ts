// PRD_OPEN_SOURCE 2.10 — hook that watches board state, fires quip events,
// and exposes the current line for Scout to display. Kept out of App.tsx to
// avoid dumping another 60 lines of state-diff logic into the top component.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "../../../core/src/types/index.ts";
import { DEFAULT_PLAYFUL, DEFAULT_DRY, QuipEngine, type Tone, type QuipEvent, type QuipSlots } from "./quips.ts";

// ─── Pure diff logic — exported so it can be tested end-to-end without a
//     React renderer. Given a prior task-state snapshot and a next one,
//     returns the list of quip events that should fire (in emit order).

export interface DiffState {
  prior: Map<string, Task>;
  failCounts: Map<string, number>;
  doneCount: number;
}

export interface DiffEvent { event: QuipEvent; slots: QuipSlots; }

export function makeDiffState(): DiffState {
  return { prior: new Map(), failCounts: new Map(), doneCount: 0 };
}

export function diffTasksToEvents(state: DiffState, tasks: readonly Task[]): DiffEvent[] {
  const events: DiffEvent[] = [];
  let doneNow = 0;
  for (const t of tasks) if (t.status === "done" || t.status === "in_review") doneNow++;

  if (doneNow > state.doneCount && tasks.length > 0) {
    events.push({ event: "milestone",        slots: { done: doneNow, total: tasks.length } });
    events.push({ event: "task_completed",   slots: {} });
  }
  state.doneCount = doneNow;

  for (const t of tasks) {
    const p = state.prior.get(t.id);
    if (!p) { state.prior.set(t.id, t); continue; }

    const wentRed = p.status !== "blocked" && t.status === "blocked" && !!t.lastError;
    if (wentRed) {
      const n = (state.failCounts.get(t.id) ?? 0) + 1;
      state.failCounts.set(t.id, n);
      const err = (t.lastError ?? "").toLowerCase();
      if (err.includes("budget") || err.includes("cap")) {
        events.push({ event: "budget_tripped", slots: {} });
      } else if (n === 1) {
        events.push({ event: "test_fail_1",  slots: { taskName: t.title } });
      } else if (n >= 3) {
        events.push({ event: "test_fail_many", slots: { taskName: t.title, n } });
      }
    }

    const wentGreen = p.status === "blocked" && (t.status === "done" || t.status === "in_review");
    if (wentGreen) {
      events.push({ event: "tests_green", slots: {} });
      state.failCounts.delete(t.id);
    }

    const gotDecision = !p.activeForm && !!t.activeForm && t.status === "blocked";
    if (gotDecision) events.push({ event: "decision_ticket", slots: {} });

    state.prior.set(t.id, t);
  }

  const alive = new Set(tasks.map((t) => t.id));
  for (const id of Array.from(state.prior.keys())) if (!alive.has(id)) state.prior.delete(id);

  return events;
}

const TONE_KEY = "agent-trail:scout-tone";
const QUIP_TTL_MS = 6500;  // how long a picked line stays on screen

export interface ScoutQuipsState {
  quip: string | null;
  tone: Tone;
  setTone: (t: Tone) => void;
  /** Manually fire an event — used by the E2E test hook and by non-task
   *  signals (resume, budget) surfaced from elsewhere. */
  fire: (event: QuipEvent, slots?: QuipSlots) => void;
}

function loadTone(): Tone {
  try {
    const v = localStorage.getItem(TONE_KEY);
    if (v === "playful" || v === "dry" || v === "off") return v;
  } catch { /* private mode */ }
  return "playful";
}

/**
 * Watches `tasks` for state transitions and translates them into quip events.
 * Returns the current quip string (nulls out after QUIP_TTL_MS) + a tone
 * setter that persists to localStorage.
 */
export function useScoutQuips(tasks: readonly Task[]): ScoutQuipsState {
  const [tone, setToneState] = useState<Tone>(() => loadTone());
  const [quip, setQuip] = useState<string | null>(null);

  // Single engine per session — keeps cooldown + shuffle state across renders.
  const engineRef = useRef<QuipEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new QuipEngine({
      pack: tone === "dry" ? DEFAULT_DRY : DEFAULT_PLAYFUL,
      tone,
    });
  }

  // Sync engine when the user flips tone.
  useEffect(() => {
    const eng = engineRef.current!;
    eng.setTone(tone);
    eng.setPack(tone === "dry" ? DEFAULT_DRY : DEFAULT_PLAYFUL);
  }, [tone]);

  const setTone = (t: Tone) => {
    setToneState(t);
    try { localStorage.setItem(TONE_KEY, t); } catch { /* private mode */ }
  };

  // Track prior task state to diff on. Ref so we don't render-loop.
  const diffStateRef = useRef<DiffState>(makeDiffState());
  const idleSinceRef = useRef<number>(Date.now());

  const fire = useMemo(() => {
    return (event: QuipEvent, slots: QuipSlots = {}) => {
      const eng = engineRef.current!;
      const line = eng.pick(event, slots);
      if (!line) return;
      setQuip(line);
    };
  }, []);

  // Auto-dismiss picked quip after TTL.
  useEffect(() => {
    if (!quip) return;
    const t = setTimeout(() => setQuip(null), QUIP_TTL_MS);
    return () => clearTimeout(t);
  }, [quip]);

  // Diff-and-fire loop. Runs on every tasks change.
  useEffect(() => {
    for (const t of tasks) if (t.status === "in_progress") { idleSinceRef.current = Date.now(); break; }
    const events = diffTasksToEvents(diffStateRef.current, tasks);
    for (const ev of events) fire(ev.event, ev.slots);
  }, [tasks, fire]);

  // Idle / empty board ambient nudges. Fire at most every ~90s via the engine
  // cooldown; the engine's own global cooldown handles overlap.
  useEffect(() => {
    if (tasks.length === 0) return; // handled by empty_board timer below
    const iv = setInterval(() => {
      const anyRunning = tasks.some((t) => t.status === "in_progress");
      if (!anyRunning && Date.now() - idleSinceRef.current > 60_000) {
        fire("idle_board");
      }
    }, 30_000);
    return () => clearInterval(iv);
  }, [tasks, fire]);

  useEffect(() => {
    if (tasks.length > 0) return;
    const iv = setInterval(() => fire("empty_board"), 45_000);
    return () => clearInterval(iv);
  }, [tasks, fire]);

  return { quip, tone, setTone, fire };
}
