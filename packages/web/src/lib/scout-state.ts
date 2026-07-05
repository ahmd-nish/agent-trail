// Pure aggregation for Scout's click-to-see state card (PRD 2.10c). Extracted
// so it's testable without React DOM.
//
// Every field here maps 1:1 to what the app already renders — the state card
// is a formatted query, not a chat.

import type { Task } from "../../../core/src/types/index.ts";

export interface RunStats {
  activeCount: number;
  queuedCount: number;
  maxConcurrent: number;
}

export interface ScoutState {
  total: number;
  inProgress: number;
  done: number;
  blocked: number;
  decisionCount: number;
  running: Task | null;
  runningPhase: string | null;
  runStats: RunStats | null;
}

export function computeScoutState(tasks: readonly Task[], runStats: RunStats | null): ScoutState {
  let inProgress = 0, done = 0, blocked = 0, decisionCount = 0;
  let running: Task | null = null;
  for (const t of tasks) {
    if (t.status === "in_progress") {
      inProgress++;
      if (!running) running = t;
    } else if (t.status === "done" || t.status === "in_review") {
      done++;
    } else if (t.status === "blocked") {
      blocked++;
      if (t.activeForm) decisionCount++;
    }
  }
  return {
    total: tasks.length,
    inProgress, done, blocked, decisionCount,
    running,
    runningPhase: running?.tddPhase ?? null,
    runStats,
  };
}
