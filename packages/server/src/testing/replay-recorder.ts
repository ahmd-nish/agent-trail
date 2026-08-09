// PRD_OPEN_SOURCE 2.8 — replay recorder.
//
// One JSONL file per execution: `<root>/.inventarium/replays/<execId>.jsonl`.
// Each line is `{ ts, event }` where `event` is exactly the UiEvent broadcast
// via SSE. Playing back is a simple line-by-line read + setTimeout gap.
//
// Size discipline:
//   • per-file cap (5 MB) — beyond that, further writes drop with a marker
//   • auto-prune replays older than N days via `pruneOldReplays()` — the
//     server's boot path calls this
// Kept synchronous because the volume is low; when a run generates thousands
// of events per second we'd move to a batched appender.

import { appendFileSync, existsSync, mkdirSync, statSync, readdirSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../../../core/src/storage/paths.ts";

const REPLAY_DIR = () => join(resolveProjectRoot(), ".inventarium", "replays");
const MAX_BYTES  = 5 * 1024 * 1024; // per-file cap
const DEFAULT_RETENTION_DAYS = 30;

const overflowed = new Set<string>();

export function recordReplayEvent(executionId: string, event: object): void {
  if (!executionId) return;
  if (overflowed.has(executionId)) return;
  try {
    const dir = REPLAY_DIR();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, `${executionId}.jsonl`);
    // Cheap size check — stat every 100 events would be plenty, but we keep
    // it simple + only stat on writes we already do.
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size >= MAX_BYTES) {
        overflowed.add(executionId);
        appendFileSync(path, `{"ts":${Date.now()},"event":{"type":"replay_truncated","atBytes":${size}}}\n`);
        return;
      }
    }
    const line = JSON.stringify({ ts: Date.now(), event }) + "\n";
    appendFileSync(path, line);
  } catch (err) {
    // Never let a recording failure crash the run.
    console.warn(`[replay-recorder] failed to write ${executionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function readReplay(executionId: string): Array<{ ts: number; event: object }> {
  const path = join(REPLAY_DIR(), `${executionId}.jsonl`);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  const out: Array<{ ts: number; event: object }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { ts: number; event: object };
      out.push(entry);
    } catch { /* skip malformed line */ }
  }
  return out;
}

export function replayPath(executionId: string): string {
  return join(REPLAY_DIR(), `${executionId}.jsonl`);
}

export function pruneOldReplays(retentionDays = DEFAULT_RETENTION_DAYS): number {
  const dir = REPLAY_DIR();
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (st.mtimeMs < cutoff) { unlinkSync(p); pruned++; }
    } catch { /* skip */ }
  }
  return pruned;
}
