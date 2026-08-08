// knowledgelayer-v2 §3.3 — the measurement that turns the adapter spike into a
// decision rather than an impression.
//
// Every metric here is deterministic and adapter-agnostic: point it at any
// CodeIndex and the numbers are comparable. That is the whole design goal —
// §3.4's criteria are meaningless unless `native` and an external backend are
// scored by identical code.
//
// One metric from §3.3 is deliberately NOT here: "discovery tool calls, with vs
// without". It requires running real agent executions on an unfamiliar repo,
// and §3.3 is explicit that measuring it on agent-trail understates the value
// (live telemetry: Grep 1, Glob 20 across 38 executions — there is no headroom
// left to recover). Reporting it from this corpus would be worse than not
// reporting it.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeIndex } from "./code-index.ts";
import { toPosixPath } from "./code-index.ts";

export interface CodeIndexBenchOptions {
  root: string;
  /** Files to measure coverage over. Defaults to the git-changed-file proxy. */
  corpus?: string[];
  /** How many commits the default corpus spans. Default 40. */
  commits?: number;
  /** Label for the corpus in the report. */
  corpusName?: string;
}

export interface CodeIndexBenchReport {
  adapter: string;
  corpus: { name: string; source: string; files: number };
  coverage: {
    filesTotal: number;
    filesWithSymbols: number;
    /** Naive rate over every file in the corpus. Reported for completeness,
     *  but it punishes the adapter for test files that export nothing — there
     *  is no symbol there to find. Do not gate on this. */
    rate: number;
    /** Files that actually declare at least one export. */
    filesDeclaringExports: number;
    /** §3.4 gate: >= 0.50. Coverage among files where a symbol EXISTS to be
     *  resolved. This is the number that says whether `governs` edges will be
     *  dense enough for §J to be worth building. */
    rateAmongExporting: number;
    symbolsTotal: number;
    symbolsPerFile: number;
  };
  latency: {
    samples: number;
    p50Ms: number;
    p99Ms: number;
    maxMs: number;
    /** §3.4 gate: p99 < 200ms — this sits on every spawn's critical path. */
    p99UnderGate: boolean;
  };
  scan: { wholeRepoMs: number; filesScanned: number; symbolsFound: number };
  /**
   * §3.4's staleness proxy. An export the extractor never captured cannot
   * change its signature hash, so a stale contract reads as verified-current.
   * The blind-spot rate IS the staleness false-negative rate.
   */
  blindSpots: {
    declaredExports: number;
    resolvedExports: number;
    missRate: number;
    /** Which export shapes are being missed, worst first. */
    byShape: Array<{ shape: string; declared: number; missed: number }>;
  };
  notes: string[];
}

/** Export shapes, as ground truth for the blind-spot metric. Order matters —
 *  first match wins, so more specific patterns come first. */
const EXPORT_SHAPES: Array<{ shape: string; re: RegExp; resolvable: boolean }> = [
  { shape: "export default", re: /^\s*export\s+default\b/, resolvable: false },
  { shape: "export * (re-export)", re: /^\s*export\s+\*/, resolvable: false },
  { shape: "export { } (re-export list)", re: /^\s*export\s*\{/, resolvable: false },
  { shape: "export function", re: /^\s*export\s+(?:async\s+)?function\s+[A-Za-z_$]/, resolvable: true },
  { shape: "export class", re: /^\s*export\s+(?:abstract\s+)?class\s+[A-Za-z_$]/, resolvable: true },
  { shape: "export interface", re: /^\s*export\s+interface\s+[A-Za-z_$]/, resolvable: true },
  { shape: "export type", re: /^\s*export\s+type\s+[A-Za-z_$]/, resolvable: true },
  { shape: "export enum", re: /^\s*export\s+enum\s+[A-Za-z_$]/, resolvable: true },
  { shape: "export const/let/var", re: /^\s*export\s+(?:const|let|var)\s+[A-Za-z_$]/, resolvable: true },
];

const SCANNABLE = /\.(m?[tj]sx?|cts|mts)$/;

/** Files touched by recent commits — a realistic stand-in for what tasks touch.
 *  Used because agent-trail's own `tasks.likely_paths` is empty on every row
 *  (the field was never populated before the Phase 0 fix). */
export function changedFileCorpus(root: string, commits = 40): string[] {
  try {
    const res = spawnSync(
      "git",
      ["-C", root, "log", "-n", String(commits), "--name-only", "--pretty=format:"],
      { encoding: "utf8", timeout: 10000, maxBuffer: 32 * 1024 * 1024 },
    );
    if (res.status !== 0) return [];
    const seen = new Set<string>();
    for (const line of res.stdout.split("\n")) {
      const f = line.trim();
      if (f && SCANNABLE.test(f)) seen.add(toPosixPath(f));
    }
    return [...seen].sort();
  } catch {
    return [];
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

export async function runCodeIndexBench(
  index: CodeIndex,
  opts: CodeIndexBenchOptions,
): Promise<CodeIndexBenchReport> {
  const notes: string[] = [];
  const commits = opts.commits ?? 40;
  const corpus = (opts.corpus ?? changedFileCorpus(opts.root, commits))
    .filter((f) => SCANNABLE.test(f));
  const corpusSource = opts.corpus
    ? "caller-supplied"
    : `git log -n ${commits} --name-only (tasks.likely_paths is empty on every row)`;

  if (corpus.length === 0) notes.push("empty corpus — coverage and latency are not meaningful");

  // ── Coverage + per-path latency ────────────────────────────────────────────
  // Timed one path at a time, because that is how the packer calls it: a task's
  // footprint resolved at spawn, not a batch.
  const durations: number[] = [];
  let filesWithSymbols = 0;
  let symbolsTotal = 0;
  const resolvedByFile = new Map<string, Set<string>>();

  for (const file of corpus) {
    const t0 = performance.now();
    const syms = await index.symbolsInPaths([file]);
    durations.push(performance.now() - t0);
    if (syms.length > 0) filesWithSymbols++;
    symbolsTotal += syms.length;
    resolvedByFile.set(file, new Set(syms.map((s) => s.name)));
  }

  durations.sort((a, b) => a - b);

  // ── Blind spots — the staleness false-negative proxy ───────────────────────
  const shapeCounts = new Map<string, { declared: number; missed: number }>();
  let declaredExports = 0;
  let resolvedExports = 0;
  let filesDeclaringExports = 0;
  let filesResolvedAmongExporting = 0;

  for (const file of corpus) {
    let content: string;
    try {
      content = readFileSync(join(opts.root, file), "utf8");
    } catch {
      continue; // deleted since the commit that touched it
    }
    // Blank block comments so a commented-out export isn't counted as ground truth.
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const resolvedHere = resolvedByFile.get(file)?.size ?? 0;
    let declaredHere = 0;

    for (const line of stripped.split("\n")) {
      if (/^\s*\/\//.test(line)) continue;
      const hit = EXPORT_SHAPES.find((s) => s.re.test(line));
      if (!hit) continue;
      declaredHere++;
      const entry = shapeCounts.get(hit.shape) ?? { declared: 0, missed: 0 };
      entry.declared++;
      // Shapes the extractor structurally cannot represent are always missed.
      if (!hit.resolvable) entry.missed++;
      shapeCounts.set(hit.shape, entry);
    }

    declaredExports += declaredHere;
    resolvedExports += Math.min(resolvedHere, declaredHere);
    if (declaredHere > 0) {
      filesDeclaringExports++;
      if (resolvedHere > 0) filesResolvedAmongExporting++;
    }
  }

  // Attribute the residual gap to resolvable shapes proportionally — those are
  // declarations the extractor *should* have caught and did not.
  const structurallyMissed = [...shapeCounts.values()].reduce((a, e) => a + e.missed, 0);
  const residual = Math.max(0, declaredExports - resolvedExports - structurallyMissed);
  if (residual > 0) {
    const resolvableShapes = EXPORT_SHAPES.filter((s) => s.resolvable)
      .map((s) => s.shape)
      .filter((s) => (shapeCounts.get(s)?.declared ?? 0) > 0);
    const totalResolvable = resolvableShapes.reduce((a, s) => a + (shapeCounts.get(s)?.declared ?? 0), 0);
    for (const shape of resolvableShapes) {
      const entry = shapeCounts.get(shape)!;
      entry.missed += Math.round(residual * (entry.declared / Math.max(1, totalResolvable)));
    }
  }

  // ── Whole-repo scan — the onboarding cost ──────────────────────────────────
  const scanT0 = performance.now();
  let scanSymbols = 0;
  const allFiles = trackedFiles(opts.root).filter((f) => SCANNABLE.test(f));
  for (const f of allFiles) {
    scanSymbols += (await index.symbolsInPaths([f])).length;
  }
  const wholeRepoMs = performance.now() - scanT0;

  const p99 = percentile(durations, 99);
  const missRate = declaredExports === 0 ? 0 : Math.min(1, Math.max(0, (declaredExports - resolvedExports) / declaredExports));

  if (index.name === "native") {
    notes.push("native reads the working tree, so it is never stale relative to disk; its false negatives come from shapes it cannot parse, which is what blindSpots measures");
  }
  notes.push("discovery-tool-call delta intentionally not measured on this corpus (§3.3)");

  return {
    adapter: index.name,
    corpus: { name: opts.corpusName ?? "agent-trail", source: corpusSource, files: corpus.length },
    coverage: {
      filesTotal: corpus.length,
      filesWithSymbols,
      rate: corpus.length === 0 ? 0 : filesWithSymbols / corpus.length,
      filesDeclaringExports,
      rateAmongExporting: filesDeclaringExports === 0 ? 0 : filesResolvedAmongExporting / filesDeclaringExports,
      symbolsTotal,
      symbolsPerFile: corpus.length === 0 ? 0 : symbolsTotal / corpus.length,
    },
    latency: {
      samples: durations.length,
      p50Ms: percentile(durations, 50),
      p99Ms: p99,
      maxMs: durations.length ? durations[durations.length - 1]! : 0,
      p99UnderGate: p99 < 200,
    },
    scan: { wholeRepoMs, filesScanned: allFiles.length, symbolsFound: scanSymbols },
    blindSpots: {
      declaredExports,
      resolvedExports,
      missRate,
      byShape: [...shapeCounts.entries()]
        .map(([shape, v]) => ({ shape, declared: v.declared, missed: v.missed }))
        .sort((a, b) => b.missed - a.missed),
    },
    notes,
  };
}

function trackedFiles(root: string): string[] {
  try {
    const res = spawnSync("git", ["-C", root, "ls-files"], { encoding: "utf8", timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
    if (res.status !== 0) return [];
    return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map(toPosixPath);
  } catch {
    return [];
  }
}

/** Human-readable report — what gets pasted into the §3.4 decision. */
export function formatBenchReport(r: CodeIndexBenchReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const ms = (n: number) => `${n.toFixed(2)}ms`;
  const lines: string[] = [];
  lines.push(`adapter: ${r.adapter}   corpus: ${r.corpus.name} (${r.corpus.files} files)`);
  lines.push(`  source: ${r.corpus.source}`);
  lines.push("");
  lines.push(`coverage        ${r.coverage.filesWithSymbols}/${r.coverage.filesDeclaringExports} exporting files = ${pct(r.coverage.rateAmongExporting)}   [GATE >= 50%]`);
  lines.push(`                ${r.coverage.filesWithSymbols}/${r.coverage.filesTotal} of all corpus files = ${pct(r.coverage.rate)} (test files export nothing — not a gate)`);
  lines.push(`                ${r.coverage.symbolsTotal} symbols, ${r.coverage.symbolsPerFile.toFixed(1)}/file`);
  lines.push(`latency         p50 ${ms(r.latency.p50Ms)}  p99 ${ms(r.latency.p99Ms)}  max ${ms(r.latency.maxMs)}   [gate p99 < 200ms: ${r.latency.p99UnderGate ? "PASS" : "FAIL"}]`);
  lines.push(`whole-repo scan ${r.scan.filesScanned} files in ${ms(r.scan.wholeRepoMs)} -> ${r.scan.symbolsFound} symbols`);
  lines.push(`blind spots     ${r.blindSpots.declaredExports - r.blindSpots.resolvedExports}/${r.blindSpots.declaredExports} declared exports unresolved = ${pct(r.blindSpots.missRate)}`);
  for (const s of r.blindSpots.byShape) {
    if (s.missed === 0) continue;
    lines.push(`                  ${s.shape}: ${s.missed}/${s.declared} missed`);
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}
