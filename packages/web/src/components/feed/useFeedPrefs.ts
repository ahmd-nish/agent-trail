import { useState } from "react";

export interface FeedPrefs {
  typewriter: boolean;
  typewriterCps: number;
  soundToolTick: boolean;
  soundCompletion: boolean;
  soundAskHuman: boolean;
  volume: number;
  confetti: boolean;
}

export const DEFAULT_PREFS: FeedPrefs = {
  typewriter: true,
  typewriterCps: 35,
  soundToolTick: false,
  soundCompletion: true,
  soundAskHuman: true,
  volume: 0.5,
  confetti: true,
};

const STORAGE_KEY = "agent-trail.prefs";

function load(): FeedPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<FeedPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function useFeedPrefs() {
  const [prefs, setPrefsState] = useState<FeedPrefs>(load);

  function setPrefs(update: Partial<FeedPrefs>) {
    setPrefsState((prev) => {
      const next = { ...prev, ...update };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }

  return { prefs, setPrefs };
}
