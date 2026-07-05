// PRD_TESTING T0.5 — topological ordering for the "Run all" flow.
//
// The old implementation iterated `filteredCases` in array order, which meant
// a case's `dependsOnCaseId` could run AFTER the case that needed it, and a
// tag filter could silently exclude a dependency. This module gives a clean,
// testable helper that:
//   1. Auto-includes any dependency excluded by the tag filter (with a note)
//   2. Sorts by longest-path depth so deps run first
//   3. Flags dangling dependsOnCaseId refs (case deleted from under us)
//   4. Detects cycles (should be impossible given a well-formed UI, but guard)

export interface OrderableCase {
  id: string;
  label?: string;
  dependsOnCaseId?: string;
}

export interface OrderResult<C extends OrderableCase> {
  /** Cases in the order the runner should execute them. */
  ordered: C[];
  /** Case ids the tag filter had excluded but were auto-included because a
   *  selected case depended on them. */
  autoIncludedIds: string[];
  /** Ids whose `dependsOnCaseId` points at a case that no longer exists in
   *  the full pool — the runner should refuse or warn. */
  danglingRefs: Array<{ caseId: string; missingDepId: string }>;
  /** True if a cycle was detected. Ordered will still be populated with a
   *  best-effort DFS pass. */
  hasCycle: boolean;
}

export function orderCasesForRun<C extends OrderableCase>(
  all: readonly C[],
  selected: readonly C[],
): OrderResult<C> {
  const byId = new Map(all.map((c) => [c.id, c]));
  const selectedIds = new Set(selected.map((c) => c.id));

  // Walk deps of everything selected — pull in any missing prerequisites.
  const autoIncludedIds: string[] = [];
  const danglingRefs: Array<{ caseId: string; missingDepId: string }> = [];
  const stack = [...selectedIds];
  const included = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (included.has(id)) continue;
    included.add(id);
    const c = byId.get(id);
    if (!c) continue;
    if (!selectedIds.has(id)) autoIncludedIds.push(id);
    const dep = c.dependsOnCaseId;
    if (!dep) continue;
    if (!byId.has(dep)) {
      danglingRefs.push({ caseId: id, missingDepId: dep });
      continue;
    }
    if (!included.has(dep)) stack.push(dep);
  }

  // Depth-first topological sort with cycle guard.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  let hasCycle = false;

  const compute = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) { hasCycle = true; return 0; }
    visiting.add(id);
    const c = byId.get(id);
    const dep = c?.dependsOnCaseId;
    const d = dep && byId.has(dep) ? compute(dep) + 1 : 0;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of included) compute(id);

  const ordered = Array.from(included)
    .map((id) => byId.get(id))
    .filter((c): c is C => !!c)
    .sort((a, b) => {
      const da = depth.get(a.id) ?? 0;
      const db = depth.get(b.id) ?? 0;
      return da - db;
    });

  return { ordered, autoIncludedIds, danglingRefs, hasCycle };
}
