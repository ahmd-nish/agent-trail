/**
 * Persistent state for the runner. The runner can crash, be SIGKILL'd, or be
 * restarted by `bun --watch` on code changes — but the dev servers it spawned
 * should survive. We track everything to disk so the runner can adopt those
 * processes on the next boot.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveHomeStateDir } from "../../core/src/storage/paths.ts";

const STATE_DIR = resolveHomeStateDir();
const LEGACY_STATE_DIR = join(homedir(), ".vibe-board");
const STATE_FILE = join(STATE_DIR, "runner-state.json");

// One-time migration: move ~/.vibe-board/ → ~/.inventarium/ if the new dir
// doesn't exist yet. Best-effort — runner state is non-critical (worst case
// the user re-starts a couple of dev servers).
if (!existsSync(STATE_DIR) && existsSync(LEGACY_STATE_DIR)) {
  try {
    renameSync(LEGACY_STATE_DIR, STATE_DIR);
    console.log(`[runner] renamed legacy state dir ${LEGACY_STATE_DIR} → ${STATE_DIR}`);
  } catch {
    // ignore; loadState() will fall through to an empty state below
  }
}

export interface PersistedServer {
  boardId: string;
  pid: number;
  port: number | null;
  command: string;
  cwd: string;
  startedAt: number;
}

export interface RunnerState {
  version: 1;
  updatedAt: number;
  servers: Record<string, PersistedServer>; // keyed by boardId
}

const emptyState = (): RunnerState => ({ version: 1, updatedAt: Date.now(), servers: {} });

export function loadState(): RunnerState {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
  } catch { /* directory exists */ }

  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as RunnerState;
    if (parsed.version !== 1) return emptyState();
    return parsed;
  } catch (err) {
    console.warn(`[runner-state] could not parse ${STATE_FILE}, starting fresh:`, err);
    return emptyState();
  }
}

/** Atomic write — temp file + rename so a crash mid-write doesn't corrupt the file. */
export function saveState(state: RunnerState): void {
  state.updatedAt = Date.now();
  try { mkdirSync(dirname(STATE_FILE), { recursive: true }); } catch { /* exists */ }
  const tmp = `${STATE_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, STATE_FILE);
}

/** Returns true iff a PID is currently running. Cheap — uses kill(pid, 0). */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
