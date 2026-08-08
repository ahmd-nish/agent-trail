// knowledgelayer-v2 §5 / knowledgelayer §4.2e — git as the validity oracle.
//
// The rule the whole section rests on: **derive staleness, never record it.**
// A `stale: true` column would be wrong the moment anyone rebases. Instead a
// contract is anchored to the commit it was extracted at, and validity is a
// QUERY answered at pack time.
//
// Why this exists at all: agent-trail does not originate every mutation to a
// repo, and no system that assumed otherwise has been right. `git revert`,
// merge-conflict resolution, rebases, dependabot bumps, generated code, a
// teammate on Cursor, a 2am one-character hotfix — none of them flow through
// here. A contract that claims a signature which no longer exists is worse
// than no contract, because a downstream agent will confidently call it.
//
// This was blocked until Phase 1: computing a signature hash requires
// re-extracting signatures, and the extractor had a 6.5% blind-spot rate.
// Symbols it never captured could not change the hash, so a drifted contract
// read as verified-current — a false negative in exactly the direction that
// destroys trust. The extractor is at 0.0% on this repo now, which is what
// makes this phase meaningful rather than theatre.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { CodeIndex } from "./code-index.ts";
import { symbolUrn } from "./code-index.ts";
import type { CapabilityContract } from "./contracts.ts";

export type ValidityStatus =
  /** Every recorded signature still resolves identically. */
  | "valid"
  /** At least one signature moved, vanished, or appeared. */
  | "drifted"
  /** Not enough information to judge — no hash recorded, or nothing resolvable. */
  | "unknown";

export interface ValidityReport {
  status: ValidityStatus;
  /** Commit the contract was extracted at. */
  baseSha: string | null;
  /** Hash recorded at emit time. */
  recordedHash: string | null;
  /** Hash recomputed now. */
  currentHash: string | null;
  /** `path#name` entries present now but not at emit. */
  added: string[];
  /** `path#name` entries present at emit but not now. */
  removed: string[];
  /** `path#name` entries whose signature text changed. */
  changed: string[];
  /** Modules the check covered. */
  checkedPaths: string[];
}

/** One canonical, adapter-neutral line per symbol. */
function entryFor(path: string, name: string, signature: string | undefined): string {
  return `${symbolUrn(path, name)} ${(signature ?? "").replace(/\s+/g, " ").trim()}`;
}

export interface SignatureSet {
  /** Sorted canonical entries — the thing that is hashed. */
  entries: string[];
  /** `path#name` -> signature text, for diffing. */
  byKey: Record<string, string>;
  hash: string;
}

export function hashEntries(entries: string[]): string {
  return createHash("sha256").update([...entries].sort().join("\n")).digest("hex");
}

/**
 * Resolve the current signature set for a contract's modules THROUGH THE
 * ADAPTER, per §5 — not through the regex extractor directly. That is what
 * makes the hash reproducible on whichever backend is active.
 *
 * Deliberately covers exported symbols only. `routes` / `tables` / `env` live
 * in the contract but no CodeIndex backend exposes them, so folding them into
 * the hash would make it unreproducible on any adapter except native — the
 * hash would then be measuring the extractor, not the code.
 */
export async function resolveSignatureSet(
  index: CodeIndex,
  paths: string[],
): Promise<SignatureSet> {
  const byKey: Record<string, string> = {};
  try {
    for (const sym of await index.symbolsInPaths(paths)) {
      byKey[symbolUrn(sym.path, sym.name)] = (sym.signature ?? "").replace(/\s+/g, " ").trim();
    }
  } catch { /* an unavailable adapter yields an empty set, reported as unknown */ }

  const entries = Object.entries(byKey)
    .map(([k, v]) => `${k} ${v}`)
    .sort();
  return { entries, byKey, hash: hashEntries(entries) };
}

/**
 * The oracle. Compares the contract's recorded signature set against the set
 * resolved from the working tree right now.
 *
 * Returns `unknown` rather than guessing when the contract predates this phase
 * (no recorded hash) or when the adapter resolved nothing — a missing answer
 * must never be reported as a clean bill of health.
 */
export async function checkContractValidity(
  contract: CapabilityContract,
  index: CodeIndex,
): Promise<ValidityReport> {
  const paths = contract.provides.modules ?? [];
  const current = await resolveSignatureSet(index, paths);

  const base: ValidityReport = {
    status: "unknown",
    baseSha: contract.baseSha ?? null,
    recordedHash: contract.signatureHash ?? null,
    currentHash: current.entries.length > 0 ? current.hash : null,
    added: [], removed: [], changed: [],
    checkedPaths: paths,
  };

  if (!contract.signatureHash || !contract.signatureEntries) return base;
  if (paths.length === 0) return base;
  // The adapter resolved nothing for files that previously had symbols. That
  // is not "valid" — it is "cannot tell", e.g. the language server is down.
  if (current.entries.length === 0 && contract.signatureEntries.length > 0) {
    return { ...base, status: "unknown" };
  }

  if (contract.signatureHash === current.hash) {
    return { ...base, status: "valid", currentHash: current.hash };
  }

  // Drifted — say exactly which symbols moved. "Something changed" is not
  // actionable; "createSession's signature changed" is.
  const recorded: Record<string, string> = {};
  for (const entry of contract.signatureEntries) {
    const sp = entry.indexOf(" ");
    if (sp < 0) { recorded[entry] = ""; continue; }
    recorded[entry.slice(0, sp)] = entry.slice(sp + 1);
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(current.byKey)) {
    if (!(key in recorded)) added.push(key);
    else if (recorded[key] !== current.byKey[key]) changed.push(key);
  }
  for (const key of Object.keys(recorded)) {
    if (!(key in current.byKey)) removed.push(key);
  }

  return {
    ...base,
    status: "drifted",
    currentHash: current.hash,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

/**
 * Re-derive a contract's structure from the working tree. Free — one more
 * adapter call — and it is what makes drift recoverable instead of merely
 * detectable.
 *
 * `invariants` and `deliberatelyNotDone` are carried over untouched and never
 * regenerated: they came from human/LLM judgement about the ORIGINAL code, and
 * a wrong invariant is worse than a missing one.
 */
export async function rederiveContract(
  contract: CapabilityContract,
  index: CodeIndex,
  opts: { baseSha?: string | null } = {},
): Promise<CapabilityContract> {
  const paths = contract.provides.modules ?? [];
  const set = await resolveSignatureSet(index, paths);
  const symbols = await index.symbolsInPaths(paths).catch(() => []);

  return {
    ...contract,
    provides: {
      ...contract.provides,
      exports: symbols.map((s) => s.signature ?? s.name).sort(),
    },
    entrypoints: symbols.map((s) => `${s.path}:${s.name}`).sort(),
    signatureHash: set.hash,
    signatureEntries: set.entries,
    // The caller owns the worktree and therefore the sha; passing it in beats
    // guessing here from an adapter that may not be filesystem-backed.
    baseSha: opts.baseSha ?? contract.baseSha ?? null,
  };
}

/** HEAD of a worktree, or null outside a repo. */
export function gitHeadSha(cwd: string): string | null {
  try {
    const res = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000 });
    return res.status === 0 ? res.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/** Prompt-facing note. Silence when valid — a downstream agent does not need
 *  to be told that things are normal. */
export function formatValidityWarning(report: ValidityReport): string {
  if (report.status === "valid") return "";
  if (report.status === "unknown") {
    return "⚠ contract validity unverified (no recorded signature hash, or the code index could not resolve these files)";
  }
  const lines = ["⚠ CONTRACT DRIFTED since it was recorded" + (report.baseSha ? ` at ${report.baseSha.slice(0, 8)}` : "")];
  if (report.changed.length) lines.push(`  signature changed: ${report.changed.join(", ")}`);
  if (report.removed.length) lines.push(`  no longer exists:  ${report.removed.join(", ")}`);
  if (report.added.length) lines.push(`  newly added:       ${report.added.join(", ")}`);
  lines.push("  The signatures below were re-derived from the current working tree.");
  return lines.join("\n");
}

export { entryFor };
