// PRD_FEED_EXPERIENCE §3 — theme registry.
//
// Themes are pure skins over the compiled beat stream. They render the SAME
// data — spectacle never replaces information. Every theme must pass a
// legibility test: all F1 info (verb, subject, why, outcome) readable.

import type { ComponentType } from "react";
import type { CompiledFeed } from "../../lib/beat-compiler.ts";

export type ThemeId = "mission-control" | "matrix" | "arcade";

export interface ThemeRendererProps {
  compiled: CompiledFeed;
  isRunning: boolean;
  /** Called when user scrolls up so the "Jump to latest" affordance shows. */
  onScrollStateChange?: (atBottom: boolean) => void;
}

export interface ThemeDef {
  id: ThemeId;
  label: string;
  description: string;
  /** Which lucide icon to show in the picker. */
  icon: "monitor" | "terminal" | "gamepad2";
  render: ComponentType<ThemeRendererProps>;
}

const STORAGE_KEY = "agent-trail:feed-theme";

export function loadPersistedTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "matrix" || raw === "arcade" || raw === "mission-control") return raw;
  } catch { /* SSR / private mode */ }
  return "mission-control";
}

export function persistTheme(theme: ThemeId): void {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
}

// Respect user's system preference — reduce-motion forces the calmest theme
// on first render. Users can still override via the picker; we don't rewrite
// their choice, we just don't push them into a busy theme by default.
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
