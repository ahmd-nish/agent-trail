import confetti from "canvas-confetti";

const STORAGE_KEY = "inventarium.lastConfettiDate";
const MILESTONE_KEY = "inventarium.completionCount";
const MILESTONES = [5, 10, 25, 50, 100];

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function burst(opts: confetti.Options = {}) {
  if (prefersReducedMotion) return;
  confetti({
    particleCount: 120,
    spread: 70,
    origin: { y: 0.6 },
    ...opts,
  });
}

/** Call whenever a task completes. Returns true if confetti fired. */
export function onTaskComplete(enabled: boolean): boolean {
  if (!enabled) return false;

  let fired = false;

  // First-of-day burst.
  const last = localStorage.getItem(STORAGE_KEY) ?? "";
  if (last !== todayStr()) {
    localStorage.setItem(STORAGE_KEY, todayStr());
    burst();
    fired = true;
  }

  // Milestone bursts (cumulative count).
  const count = (Number(localStorage.getItem(MILESTONE_KEY) ?? 0)) + 1;
  localStorage.setItem(MILESTONE_KEY, String(count));
  if (MILESTONES.includes(count)) {
    setTimeout(() => burst({ particleCount: 200, spread: 100 }), fired ? 600 : 0);
    fired = true;
  }

  return fired;
}
