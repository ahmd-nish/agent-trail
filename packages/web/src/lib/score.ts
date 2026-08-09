const TODAY_KEY  = "inventarium.score.today";
const DATE_KEY   = "inventarium.score.date";
const STREAK_KEY = "inventarium.score.streak";
const LAST_KEY   = "inventarium.score.lastActive";
const TOTAL_KEY  = "inventarium.score.total";

const MILESTONES = [5, 10, 25, 50, 100, 200, 500];

function todayStr() { return new Date().toISOString().slice(0, 10); }
function yesterdayStr() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface Score {
  today: number;
  streak: number;
  total: number;
}

export function getScore(): Score {
  const today = todayStr();
  const storedDate = localStorage.getItem(DATE_KEY) ?? "";
  const todayCount = storedDate === today ? Number(localStorage.getItem(TODAY_KEY) ?? 0) : 0;
  return {
    today: todayCount,
    streak: Number(localStorage.getItem(STREAK_KEY) ?? 0),
    total: Number(localStorage.getItem(TOTAL_KEY) ?? 0),
  };
}

export interface CompletionResult extends Score {
  milestone: number | null;
  isFirstToday: boolean;
}

export function recordCompletion(): CompletionResult {
  const today = todayStr();
  const storedDate = localStorage.getItem(DATE_KEY) ?? "";
  const lastActive = localStorage.getItem(LAST_KEY) ?? "";

  // Reset daily count if it's a new day
  let todayCount = storedDate === today ? Number(localStorage.getItem(TODAY_KEY) ?? 0) : 0;
  const isFirstToday = todayCount === 0;
  todayCount += 1;
  localStorage.setItem(TODAY_KEY, String(todayCount));
  localStorage.setItem(DATE_KEY, today);

  // Streak logic
  let streak = Number(localStorage.getItem(STREAK_KEY) ?? 0);
  if (lastActive === yesterdayStr() || lastActive === today) {
    if (lastActive !== today) streak += 1;
  } else {
    streak = 1;
  }
  localStorage.setItem(STREAK_KEY, String(streak));
  localStorage.setItem(LAST_KEY, today);

  // Total cumulative
  const total = Number(localStorage.getItem(TOTAL_KEY) ?? 0) + 1;
  localStorage.setItem(TOTAL_KEY, String(total));

  const milestone = MILESTONES.includes(total) ? total : null;

  return { today: todayCount, streak, total, milestone, isFirstToday };
}
