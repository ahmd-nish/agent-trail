import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// PRD_OPEN_SOURCE §4.4 — lightweight repo map.
//
// Ranks the tracked files in a repo by term overlap with a task's text.
// No tree-sitter, no embeddings — this is the shortest path to "just tell
// the agent which handful of files are relevant" that still works offline
// and costs nothing per query.
//
// A follow-up can swap the ranker for a real symbol map + BM25 without
// changing this API.

export interface FileScore {
  path: string;
  score: number;
}

export interface RepoMapOptions {
  /** Absolute path to the git repo root. */
  root: string;
  /** How many files to return. Default 8. */
  topN?: number;
  /** Optional path prefix filter (e.g. "packages/server/"). */
  pathPrefix?: string;
  /** Override for tests — a synthetic file list instead of `git ls-files`. */
  fileListOverride?: string[];
}

const STOP_WORDS = new Set([
  "a","an","and","are","as","at","be","by","for","from","has","have","in","is","it","its","of","on","or","that","the","to","was","will","with",
]);

export function rankRelevantFiles(taskText: string, opts: RepoMapOptions): FileScore[] {
  const files = opts.fileListOverride ?? listTrackedFiles(opts.root);
  const filtered = opts.pathPrefix
    ? files.filter((f) => f.startsWith(opts.pathPrefix!))
    : files;
  const terms = tokenize(taskText);
  if (terms.length === 0) return [];

  const scored: FileScore[] = filtered.map((path) => ({
    path,
    score: scoreFile(path, terms),
  })).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.topN ?? 8);
}

function listTrackedFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    const res = spawnSync("git", ["-C", root, "ls-files"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (res.status !== 0) return [];
    return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function scoreFile(path: string, terms: string[]): number {
  const lower = path.toLowerCase();
  const pathTokens = tokenize(path.replace(/[/_.-]/g, " "));
  const pathSet = new Set(pathTokens);
  let termHits = 0;
  for (const term of terms) {
    // Full path substring match — strong signal (component name in the path).
    if (lower.includes(term)) termHits += 3;
    // Tokenized path match — filename tokens like "auth" in "auth/login.ts".
    if (pathSet.has(term)) termHits += 2;
  }
  if (termHits === 0) return 0;
  // Only add the file-type bonus AFTER a term matched — otherwise every
  // source file leaks into the result set even for irrelevant queries.
  // Code files rank above docs on equal term match.
  let bonus = 0;
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|rb|swift|kt)$/i.test(path)) bonus = 2;
  else if (/\.md$/i.test(path)) bonus = 1;
  return termHits + bonus;
}
