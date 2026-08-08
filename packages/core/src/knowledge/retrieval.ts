// knowledgelayer-v2 §6 / knowledgelayer §4.3 — hybrid retrieval over the
// joined graph.
//
// Two seed sources, one ranking:
//
//   LEXICAL     FTS5/BM25 over knowledge_events — finds facts whose TEXT
//               resembles the task. Already shipped.
//   STRUCTURAL  Q1 reverse lookup from the task's file footprint through
//               knowledge_edges — finds facts attached to the CODE the task
//               will touch, whether or not any word matches.
//
// Structural seeding is what makes the graph pay. Similarity alone cannot
// answer "I'm changing createSession, what breaks?" — the answer has no
// lexical overlap with the question. That is also why the two sources are
// merged and scored TOGETHER rather than rendered as two prompt sections: the
// same event reached both ways is one fact, and printing it twice spends the
// budget this layer exists to protect.
//
// Deferred deliberately (§6): embeddings, vector kNN, RRF fusion. The
// category's own evidence is that structure beats similarity for code, and
// BM25 + structural seeding covers the cases we have. Revisit when
// measurement shows a gap, not before.

import type { Database } from "bun:sqlite";
import type { CodeIndex } from "./code-index.ts";
import { toPosixPath } from "./code-index.ts";
import { blastRadius, knowledgeGoverning, type GoverningHit } from "./edges.ts";
import { search, type SearchHit } from "./search.ts";
import type { KnowledgeEvent } from "./types.ts";

export type SeedSource = "lexical" | "structural";

export interface RetrievedFact {
  event: KnowledgeEvent;
  /** Every way this fact was reached. A fact found BOTH ways is stronger. */
  sources: SeedSource[];
  /** URN the structural seed matched, when there was one. */
  via: string | null;
  /** 0 = the task's own files, 1 = reached via the code graph. */
  hops: number;
  score: number;
}

export interface RetrievalOptions {
  workspaceId?: string;
  projectId?: string;
  /** Hard budget on facts returned. Default 8. */
  limit?: number;
  /** Lexical seeds pulled before scoring. Default 10. */
  lexicalSeeds?: number;
  /** Exclude a task's own events — they are not news to it. */
  excludeTaskId?: string | null;
  /** Now, injectable for deterministic tests. */
  now?: Date;
}

const CONFIDENCE_WEIGHT: Record<string, number> = { ruling: 1.0, observed: 0.8, inferred: 0.5 };

/** §6 addition to the §4.3 formula: a regex-resolved edge is weaker evidence
 *  than one from a type-aware index. `paths`/`contract` edges are exact — they
 *  came from a literal file list, not from parsing. */
const RESOLVER_WEIGHT: Record<string, number> = {
  paths: 1.0,
  contract: 1.0,
  native: 0.6,
};

/** Half-life in days. Rulings never decay — a human decision does not become
 *  less true because it is old; it becomes false only when superseded, which
 *  the query already filters on. */
const RECENCY_HALF_LIFE_DAYS = 60;

function recencyDecay(event: KnowledgeEvent, now: Date): number {
  if (event.confidence === "ruling") return 1.0;
  const t = Date.parse(event.validFrom);
  if (!Number.isFinite(t)) return 1.0;
  const days = Math.max(0, (now.getTime() - t) / 86_400_000);
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
}

/** Boost when the fact's own paths intersect the task's footprint. */
function pathOverlapBoost(event: KnowledgeEvent, footprint: Set<string>): number {
  if (footprint.size === 0 || event.paths.length === 0) return 1.0;
  return event.paths.some((p) => footprint.has(toPosixPath(p))) ? 1.3 : 1.0;
}

/**
 * Seed → score → cut.
 *
 * `index` is optional: without it the structural half falls back to Q1 (direct
 * footprint) instead of Q2 (blast radius). Retrieval degrades in reach, never
 * in correctness.
 */
export async function retrieveForTask(
  db: Database,
  input: { text: string; paths: string[] },
  index?: CodeIndex,
  opts: RetrievalOptions = {},
): Promise<RetrievedFact[]> {
  const now = opts.now ?? new Date();
  const footprint = new Set(input.paths.map(toPosixPath));
  const merged = new Map<string, RetrievedFact>();

  const add = (
    event: KnowledgeEvent,
    source: SeedSource,
    base: number,
    via: string | null,
    hops: number,
  ) => {
    if (opts.excludeTaskId && event.taskId === opts.excludeTaskId) return;
    const score = base
      * (CONFIDENCE_WEIGHT[event.confidence] ?? 0.5)
      * recencyDecay(event, now)
      * pathOverlapBoost(event, footprint);

    const prev = merged.get(event.id);
    if (!prev) {
      merged.set(event.id, { event, sources: [source], via, hops, score });
      return;
    }
    // Reached both ways: keep the better provenance and ADD the scores, so a
    // fact that is both textually similar and structurally attached outranks
    // one that is only either.
    if (!prev.sources.includes(source)) prev.sources.push(source);
    prev.score += score;
    if (hops < prev.hops) { prev.hops = hops; prev.via = via; }
  };

  // ── Structural seed ────────────────────────────────────────────────────────
  if (input.paths.length > 0) {
    let hits: GoverningHit[] = [];
    try {
      hits = index
        ? await blastRadius(db, input.paths, index, {
            workspaceId: opts.workspaceId, projectId: opts.projectId, limit: 25,
          })
        : knowledgeGoverning(db, input.paths, {
            workspaceId: opts.workspaceId, projectId: opts.projectId, limit: 25,
          });
    } catch { /* structural half is best-effort */ }

    for (const h of hits) {
      const resolver = RESOLVER_WEIGHT[h.resolver] ?? 0.6;
      // h.score already carries edge weight x confidence x hop decay; divide
      // the confidence back out so `add` applies it once, not twice.
      const edgeAndHop = h.score / (CONFIDENCE_WEIGHT[h.event.confidence] ?? 0.5);
      add(h.event, "structural", edgeAndHop * resolver, h.via, h.hops);
    }
  }

  // ── Lexical seed ───────────────────────────────────────────────────────────
  if (input.text.trim()) {
    let hits: SearchHit[] = [];
    try {
      hits = search(db, input.text, { limit: opts.lexicalSeeds ?? 10 });
    } catch { /* lexical half is best-effort */ }

    // Rank-based, not raw-bm25-based: BM25 scores are not comparable across
    // queries, and mixing an uncalibrated score with the structural side would
    // let one source silently dominate.
    hits.forEach((h, i) => add(h.event, "lexical", 1 / (1 + i), null, 0));
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 8);
}

/**
 * Prompt-ready render. Signatures, paths and facts — never file contents.
 * Says HOW each fact was reached, because "why am I being told this" is the
 * difference between context and noise.
 */
export function formatRetrievedFacts(facts: RetrievedFact[]): string {
  if (facts.length === 0) return "";
  const lines: string[] = [];
  for (const f of facts) {
    const date = f.event.validFrom.slice(0, 10);
    const how = f.sources.includes("structural")
      ? (f.hops > 0 ? `governs a caller of your files` : `governs ${f.via ?? "your files"}`)
      : "similar to this task";
    lines.push(`- **${date} · ${f.event.actorName} · ${f.event.type}** — ${f.event.subject}`);
    lines.push(`  _${how}_`);
    const body = f.event.body.trim();
    if (body) lines.push(`  ${body.split("\n").join("\n  ")}`);
  }
  return lines.join("\n");
}
