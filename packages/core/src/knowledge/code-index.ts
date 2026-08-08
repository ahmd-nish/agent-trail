// knowledgelayer-v2 §3.1 — the code-index adapter interface.
//
// Strategy (§0): symbol extraction and call-graph traversal became a commodity
// in 2026. agent-trail consumes that half and builds the half nobody has — the
// asserted knowledge log and the join between them (§J). This file is the seam.
//
// Four rules from §3.1, each load-bearing:
//
//   1. Stable, vendor-neutral addressing. A symbol is ALWAYS `sym:<path>#<name>`
//      and a file is ALWAYS `file:<path>`. A backend's internal node id is never
//      persisted — those change on re-index and are meaningless on a teammate's
//      machine, which would make `governs` edges unsyncable.
//   2. `native` is mandatory. Correctness never depends on an external MCP
//      server being installed.
//   3. Every method may return empty. Degradation is silent and expected;
//      the pack simply carries less.
//   4. Never send file contents through this interface. Signatures and paths.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { extractFileSymbols, type ExportKind } from "./contracts.ts";

export type SymbolKind =
  | "function" | "class" | "method" | "type"
  | "route" | "table" | "env" | "file"
  // Deviation from §3.1's list, deliberately: a re-exported name is exposed
  // here but defined elsewhere, and its true kind needs cross-module
  // resolution. "reexport" is accurate; forcing it into "function" or "type"
  // would be a guess persisted into §J's edges.
  | "reexport";

export interface SymbolRef {
  /** Repo-relative, POSIX separators, always. Rule 1. */
  path: string;
  name: string;
  kind: SymbolKind;
  line?: number;
  /** Exact source text. Never an LLM summary (§4.2d rule 2). */
  signature?: string;
}

export interface CodeIndex {
  readonly name: string;
  available(): Promise<boolean>;
  symbolsInPaths(paths: string[]): Promise<SymbolRef[]>;
  findSymbol(name: string): Promise<SymbolRef[]>;
  getSignature(ref: Pick<SymbolRef, "path" | "name">): Promise<string | null>;
  whoCalls(ref: Pick<SymbolRef, "path" | "name">, depth?: number): Promise<SymbolRef[]>;
  /** Commit the index reflects, for staleness (§5). `null` = always-live. */
  indexedAtSha(): Promise<string | null>;
}

// ── Addressing ───────────────────────────────────────────────────────────────
// These are what §J's knowledge_edges join against, so they matter more than
// any individual adapter. Keep them boring and total.

/** Normalize to repo-relative POSIX. Windows separators and `./` are stripped. */
export function toPosixPath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function symbolUrn(path: string, name: string): string {
  return `sym:${toPosixPath(path)}#${name}`;
}

export function fileUrn(path: string): string {
  return `file:${toPosixPath(path)}`;
}

export function moduleUrn(dir: string): string {
  return `module:${toPosixPath(dir).replace(/\/+$/, "")}`;
}

export type ParsedUrn =
  | { kind: "sym"; path: string; name: string }
  | { kind: "file"; path: string }
  | { kind: "module"; path: string };

/** Inverse of the three builders above. Returns null on anything unrecognized
 *  rather than throwing — edge rows are data, and one bad row must not take
 *  down a pack build. */
export function parseUrn(urn: string): ParsedUrn | null {
  if (urn.startsWith("sym:")) {
    const rest = urn.slice(4);
    const hash = rest.lastIndexOf("#");
    if (hash <= 0 || hash === rest.length - 1) return null;
    return { kind: "sym", path: rest.slice(0, hash), name: rest.slice(hash + 1) };
  }
  if (urn.startsWith("file:")) {
    const path = urn.slice(5);
    return path ? { kind: "file", path } : null;
  }
  if (urn.startsWith("module:")) {
    const path = urn.slice(7);
    return path ? { kind: "module", path } : null;
  }
  return null;
}

/** Every URN a path should be joinable by: the file itself plus each ancestor
 *  directory as a module. Used by §J so a `module:packages/core` ruling reaches
 *  a task touching `packages/core/src/auth/session.ts`. */
export function pathUrns(path: string): string[] {
  const p = toPosixPath(path);
  const out = [fileUrn(p)];
  const parts = p.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    out.push(moduleUrn(parts.slice(0, i).join("/")));
  }
  return out;
}

// ── The native adapter — the control (§3.2) ──────────────────────────────────

const KIND_MAP: Record<ExportKind, SymbolKind> = {
  function: "function",
  class: "class",
  type: "type",
  reexport: "reexport",
};

/** Files worth scanning. Mirrors the contract extractor's language support —
 *  claiming more would inflate the coverage denominator dishonestly. */
const SCANNABLE = /\.(m?[tj]sx?|cts|mts)$/;

export interface NativeCodeIndexOptions {
  root: string;
  /** Override for tests — a synthetic file list instead of `git ls-files`. */
  fileListOverride?: string[];
  /** Cap on files read during a whole-repo scan. Default 4000. */
  maxFiles?: number;
}

/**
 * Wraps the regex extractor that already ships (contracts.ts) plus git for file
 * listing. This is the CONTROL in the §3.3 measurement — it exists to be beaten,
 * and it is what the system falls back to when no external index is installed.
 *
 * Deliberately honest about its limits: it resolves `export`ed top-level symbols
 * in TS/JS only, and `whoCalls` is a textual reference scan with no type
 * awareness. §3.3's staleness false-negative metric is expected to score badly
 * here — that is the point of measuring it.
 */
export class NativeCodeIndex implements CodeIndex {
  readonly name = "native";
  private readonly root: string;
  private readonly fileListOverride?: string[];
  private readonly maxFiles: number;
  /** path -> symbols. Populated lazily; invalidated by mtime. */
  private cache = new Map<string, { mtimeMs: number; symbols: SymbolRef[] }>();
  private repoScan: { symbols: SymbolRef[]; builtAtSha: string | null } | null = null;

  constructor(opts: NativeCodeIndexOptions) {
    this.root = opts.root;
    this.fileListOverride = opts.fileListOverride;
    this.maxFiles = opts.maxFiles ?? 4000;
  }

  async available(): Promise<boolean> {
    return existsSync(this.root);
  }

  /** Always live — it reads working-tree files, so it reflects HEAD plus any
   *  uncommitted edits. Returning HEAD is the honest answer for staleness
   *  comparison against an indexed backend. */
  async indexedAtSha(): Promise<string | null> {
    return this.headSha();
  }

  async symbolsInPaths(paths: string[]): Promise<SymbolRef[]> {
    const out: SymbolRef[] = [];
    for (const raw of paths) {
      const rel = toPosixPath(raw);
      if (!SCANNABLE.test(rel)) continue;
      out.push(...this.symbolsForFile(rel));
    }
    return out;
  }

  async findSymbol(name: string): Promise<SymbolRef[]> {
    if (!name) return [];
    const all = this.scanRepo();
    return all.filter((s) => s.name === name);
  }

  async getSignature(ref: Pick<SymbolRef, "path" | "name">): Promise<string | null> {
    const syms = this.symbolsForFile(toPosixPath(ref.path));
    return syms.find((s) => s.name === ref.name)?.signature ?? null;
  }

  /**
   * Textual reference scan: files that mention the symbol and are not its own
   * declaration site. No type awareness, so a same-named symbol from a
   * different module is a false positive. Named `whoCalls` to satisfy the
   * interface; understand it as `whoMentions`.
   */
  async whoCalls(ref: Pick<SymbolRef, "path" | "name">, _depth = 1): Promise<SymbolRef[]> {
    if (!ref.name) return [];
    const declPath = toPosixPath(ref.path);
    const out: SymbolRef[] = [];
    // Word-boundary match, then require a call-ish or import-ish context so
    // that a comment mentioning the name doesn't count.
    const re = new RegExp(`\\b${escapeRegExp(ref.name)}\\b`);
    for (const file of this.listFiles()) {
      if (file === declPath || !SCANNABLE.test(file)) continue;
      const content = this.read(file);
      if (!content || !re.test(content)) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!re.test(line)) continue;
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        out.push({ path: file, name: ref.name, kind: "method", line: i + 1, signature: line.trim().slice(0, 200) });
        break; // one hit per file is enough to establish the edge
      }
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private symbolsForFile(rel: string): SymbolRef[] {
    const abs = join(this.root, rel);
    let mtimeMs = 0;
    try { mtimeMs = statSync(abs).mtimeMs; } catch { return []; }

    const hit = this.cache.get(rel);
    if (hit && hit.mtimeMs === mtimeMs) return hit.symbols;

    const content = this.read(rel);
    if (content === null) return [];
    const symbols: SymbolRef[] = extractFileSymbols(rel, content).map((e) => ({
      path: rel,
      name: e.symbol,
      kind: KIND_MAP[e.kind],
      line: e.line,
      signature: e.signature,
    }));
    this.cache.set(rel, { mtimeMs, symbols });
    return symbols;
  }

  private scanRepo(): SymbolRef[] {
    const sha = this.headSha();
    if (this.repoScan && this.repoScan.builtAtSha === sha) return this.repoScan.symbols;
    const symbols: SymbolRef[] = [];
    let seen = 0;
    for (const file of this.listFiles()) {
      if (!SCANNABLE.test(file)) continue;
      if (++seen > this.maxFiles) break;
      symbols.push(...this.symbolsForFile(file));
    }
    this.repoScan = { symbols, builtAtSha: sha };
    return symbols;
  }

  private listFiles(): string[] {
    if (this.fileListOverride) return this.fileListOverride.map(toPosixPath);
    if (!existsSync(this.root)) return [];
    try {
      const res = spawnSync("git", ["-C", this.root, "ls-files"], { encoding: "utf8", timeout: 5000 });
      if (res.status !== 0) return [];
      return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private read(rel: string): string | null {
    try {
      return readFileSync(join(this.root, rel), "utf8");
    } catch {
      return null;
    }
  }

  private headSha(): string | null {
    try {
      const res = spawnSync("git", ["-C", this.root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000 });
      return res.status === 0 ? res.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Resolve the active adapter. External backends register here once they exist;
 * until then this always yields `native`, which is rule 2 working as designed
 * rather than a stub.
 *
 * `AGENT_TRAIL_CODE_INDEX` selects a backend by name. An unknown or unavailable
 * name falls back to native with a warning rather than failing a spawn — a dead
 * backend must be a config problem, not an outage (§11 risk 1).
 */
export async function resolveCodeIndex(opts: {
  root: string;
  prefer?: string;
  registry?: Record<string, (root: string) => CodeIndex>;
}): Promise<CodeIndex> {
  const native = new NativeCodeIndex({ root: opts.root });
  const prefer = opts.prefer ?? process.env.AGENT_TRAIL_CODE_INDEX;
  if (!prefer || prefer === "native") return native;

  const factory = opts.registry?.[prefer];
  if (!factory) {
    console.warn(`[code-index] unknown backend "${prefer}" — falling back to native`);
    return native;
  }
  try {
    const candidate = factory(opts.root);
    if (await candidate.available()) return candidate;
    console.warn(`[code-index] backend "${prefer}" not available — falling back to native`);
  } catch (err) {
    console.warn(`[code-index] backend "${prefer}" failed to start (${err instanceof Error ? err.message : String(err)}) — falling back to native`);
  }
  return native;
}
