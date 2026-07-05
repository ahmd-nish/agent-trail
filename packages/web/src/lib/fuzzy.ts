/** Lightweight fuzzy scorer — returns 0 (no match) or a positive score. */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact prefix bonus.
  if (t.startsWith(q)) return 1000 + (1 / t.length);

  let qi = 0;
  let score = 0;
  let gap = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += (gap === 0 ? 3 : 1);
      gap = 0;
      qi++;
    } else {
      gap++;
    }
  }
  if (qi < q.length) return 0; // not all chars matched
  return score;
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
): T[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(query, getText(item)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}
