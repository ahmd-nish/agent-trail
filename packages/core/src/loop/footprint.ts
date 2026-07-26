// PRD_OPEN_SOURCE §4.7 — file-footprint parallelism.
//
// Two tasks that are DAG-independent might still touch the same files
// (e.g. both extend `src/routes/notes.ts`). Running them concurrently in
// separate worktrees produces a hairy merge — better to serialise them.
// This module is pure: the caller (board runner) invokes `hasOverlap` to
// decide whether it's safe to start a task while another is in flight.

export function normalisePath(p: string): string {
  // Strip leading `./`, trailing slashes, and collapse duplicate slashes.
  // Case-preserved — matching Linux/Mac semantics; on case-insensitive FS
  // the runner still gets it right because the ranker + git ls both produce
  // canonical casing.
  return p
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

/**
 * True iff any path in `a` overlaps any path in `b`. Overlap means:
 *   • exact same file, OR
 *   • one is a prefix directory of the other (a="src/routes/", b="src/routes/notes.ts").
 * We do NOT treat two files under the same directory as overlapping — only
 * whole-directory footprints. That's the pragmatic middle ground: too loose
 * and every task under `src/` serialises; too strict and real conflicts slip.
 */
export function hasOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const na = a.map(normalisePath).filter(Boolean);
  const nb = b.map(normalisePath).filter(Boolean);
  for (const x of na) {
    for (const y of nb) {
      if (x === y) return true;
      // Either side may be a directory footprint. `src/routes` overlaps
      // `src/routes/notes.ts`; `src/a.ts` and `src/b.ts` do not overlap.
      if (y.startsWith(`${x}/`) || x.startsWith(`${y}/`)) return true;
    }
  }
  return false;
}

/**
 * Given a candidate task's paths + a map of currently-running tasks' paths,
 * return the id of the first conflicting running task, or null if the
 * candidate is safe to launch.
 */
export function findConflict(candidate: string[], running: Map<string, string[]>): string | null {
  for (const [id, paths] of running.entries()) {
    if (hasOverlap(candidate, paths)) return id;
  }
  return null;
}
