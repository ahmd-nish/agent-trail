// §4.2b — capability contracts. The doc's own line: "the highest-value
// single artifact in the system and the current code does not produce it."
//
// This module does the deterministic extraction (§4.2b, first three rows
// of the extraction table). The LLM step for `invariants` and
// `deliberately_not_done` is a later add — for now those fields are empty
// and the downstream consumer degrades gracefully.
//
// Approach: TypeScript-focused regex + line scan over the actual files a
// task touched. Not tree-sitter yet — the doc calls it out as the future
// pick for polyglot support, but for a TS/JS-first repo (which is what
// most Claude Code users have) a well-anchored regex is fast, correct
// enough for the common shapes, has zero WASM cold-start cost, and needs
// zero new deps.
//
// Contracts are emitted as the BODY of an artifact_summary event so
// nothing about the event log's shape changes. Consumers can `JSON.parse`
// the body and check for the `provides` field to distinguish a real
// contract from a prose fallback.

export interface CapabilityContract {
  type: "capability_contract";
  taskId: string | null;
  baseSha: string | null;
  provides: {
    modules: string[];
    exports: string[];
    routes: string[];
    tables: string[];
    env: string[];
    events: string[];
  };
  invariants: string[];
  deliberatelyNotDone: string[];
  entrypoints: string[];
}

export interface ExtractContractInput {
  taskId?: string | null;
  baseSha?: string | null;
  files: Array<{ path: string; content: string }>;
}

/**
 * Extract a capability contract from a set of files a task touched.
 * Returns null when no exportable structure was found — the caller should
 * fall back to the prose artifact_summary in that case.
 */
export function extractContract(input: ExtractContractInput): CapabilityContract | null {
  const modules = new Set<string>();
  const exports = new Set<string>();
  const routes = new Set<string>();
  const tables = new Set<string>();
  const env = new Set<string>();
  const events = new Set<string>();
  const entrypoints = new Set<string>();

  for (const { path, content } of input.files) {
    if (!path || !content) continue;
    modules.add(path);
    if (isTypeScriptish(path)) {
      for (const sig of extractExportsTS(content)) {
        exports.add(sig.signature);
        entrypoints.add(`${path}:${sig.symbol}`);
      }
    }
    // Framework-agnostic: same regex works for Hono, Express, Fastify.
    for (const r of extractRoutes(content)) routes.add(r);
    for (const t of extractTables(content)) tables.add(t);
    for (const e of extractEnvReads(content)) env.add(e);
    for (const ev of extractEmittedEvents(content)) events.add(ev);
  }

  const totalProvides = exports.size + routes.size + tables.size + env.size + events.size;
  if (totalProvides === 0) return null;

  return {
    type: "capability_contract",
    taskId: input.taskId ?? null,
    baseSha: input.baseSha ?? null,
    provides: {
      modules: [...modules].sort(),
      exports: [...exports].sort(),
      routes: [...routes].sort(),
      tables: [...tables].sort(),
      env: [...env].sort(),
      events: [...events].sort(),
    },
    invariants: [],
    deliberatelyNotDone: [],
    entrypoints: [...entrypoints].sort(),
  };
}

/** Human-readable render for prompt injection. Compact — signatures only. */
export function renderContract(contract: CapabilityContract): string {
  const lines: string[] = [];
  const p = contract.provides;
  if (p.modules.length) lines.push(`modules: ${p.modules.join(", ")}`);
  if (p.exports.length) {
    lines.push("exports:");
    for (const e of p.exports) lines.push(`  ${e}`);
  }
  if (p.routes.length) lines.push(`routes: ${p.routes.join(", ")}`);
  if (p.tables.length) {
    lines.push("tables:");
    for (const t of p.tables) lines.push(`  ${t}`);
  }
  if (p.env.length) lines.push(`env: ${p.env.join(", ")}`);
  if (p.events.length) lines.push(`events: ${p.events.join(", ")}`);
  if (contract.entrypoints.length) {
    lines.push("entrypoints:");
    for (const e of contract.entrypoints) lines.push(`  ${e}`);
  }
  if (contract.invariants.length) {
    lines.push("invariants:");
    for (const i of contract.invariants) lines.push(`  - ${i}`);
  }
  if (contract.deliberatelyNotDone.length) {
    lines.push("deliberately-not-done:");
    for (const d of contract.deliberatelyNotDone) lines.push(`  - ${d}`);
  }
  return lines.join("\n");
}

function isTypeScriptish(path: string): boolean {
  return /\.(m?[tj]sx?|cts|mts)$/.test(path);
}

interface ExportSig { symbol: string; signature: string; }

/**
 * TypeScript export extraction. Anchored patterns for the common shapes:
 *   export function name(args): Return
 *   export async function name(args): Promise<Return>
 *   export const name = (args) => ...
 *   export const name: Type = ...
 *   export class Name
 *   export interface Name
 *   export type Name = ...
 *   export enum Name
 *
 * Multiline signatures are joined by cleaning up whitespace. This is
 * sig-only extraction — no body, so a 3-page function still gets a one-
 * line entry in the contract.
 */
function extractExportsTS(content: string): ExportSig[] {
  const out: ExportSig[] = [];
  // Strip block comments so regex doesn't match "export" inside comments.
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "");
  const lines = stripped.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trimEnd();
    if (!raw) continue;
    // Skip line-comments quickly.
    if (/^\s*\/\//.test(raw)) continue;

    // export [async] function name(args): return
    const fn = raw.match(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\<[^>]+\>)?\s*\(/);
    if (fn) {
      const symbol = fn[1] as string;
      const signature = collectSignature(lines, i, ")", ":", "{").trim();
      const clean = signature.replace(/\s+/g, " ").replace(/\s*\{\s*$/, "");
      out.push({ symbol, signature: clean.replace(/^export\s+/, "") });
      continue;
    }

    // export const name = (...) => ... — arrow function form
    const arrow = raw.match(/^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?\(/);
    if (arrow) {
      const symbol = arrow[1] as string;
      const signature = collectSignature(lines, i, ")", "=>", ";").trim().replace(/\s+/g, " ");
      const clean = signature.replace(/^export\s+/, "");
      out.push({ symbol, signature: clean });
      continue;
    }

    // export const name: Type = ...
    const typedConst = raw.match(/^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*:\s*([^=]+)\s*=/);
    if (typedConst) {
      const symbol = typedConst[1] as string;
      const typ = (typedConst[2] as string).trim();
      out.push({ symbol, signature: `const ${symbol}: ${typ}` });
      continue;
    }

    // export const NAME = <primitive-literal>
    const litConst = raw.match(/^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=/);
    if (litConst) {
      const symbol = litConst[1] as string;
      out.push({ symbol, signature: `const ${symbol}` });
      continue;
    }

    // export class / interface / abstract class
    const cls = raw.match(/^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (cls) { out.push({ symbol: cls[1] as string, signature: `class ${cls[1]}` }); continue; }

    const iface = raw.match(/^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/);
    if (iface) { out.push({ symbol: iface[1] as string, signature: `interface ${iface[1]}` }); continue; }

    // export type Name = ...   (single-line RHS or across lines — sig captures the first line only)
    const typ = raw.match(/^\s*export\s+type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\s*=\s*(.+?)\s*(?:;|\/\/|$)/);
    if (typ) {
      const symbol = typ[1] as string;
      const rhs = (typ[2] as string).trim();
      out.push({ symbol, signature: `type ${symbol} = ${rhs.length > 80 ? rhs.slice(0, 80) + "…" : rhs}` });
      continue;
    }

    const en = raw.match(/^\s*export\s+enum\s+([A-Za-z_$][\w$]*)/);
    if (en) { out.push({ symbol: en[1] as string, signature: `enum ${en[1]}` }); continue; }
  }

  // Dedupe by symbol name — a `function foo` with an accompanying interface
  // `foo` would both surface here and the downstream reader only needs one.
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.symbol) ? false : (seen.add(e.symbol), true)));
}

/**
 * Collect a multiline signature starting at line index `startIdx`. Reads
 * until we see any of the terminator tokens outside parentheses.
 */
function collectSignature(lines: string[], startIdx: number, ...terminators: string[]): string {
  const bag: string[] = [];
  let depth = 0;
  for (let i = startIdx; i < lines.length && i - startIdx < 20; i++) {
    const line = lines[i] ?? "";
    bag.push(line);
    for (const ch of line) {
      if (ch === "(" || ch === "<") depth++;
      else if (ch === ")" || ch === ">") depth--;
    }
    if (depth <= 0) {
      // Once we're at depth 0 or below, look for a terminator on this line.
      for (const t of terminators) {
        if (line.includes(t)) return bag.join(" ");
      }
    }
  }
  return bag.join(" ");
}

function extractRoutes(content: string): string[] {
  const out: string[] = [];
  // Matches: app.get("…"), router.post('…'), api.delete("/x"), routes.put(`…`)
  const re = /\b(?:app|router|api|routes?)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(`${m[1]?.toUpperCase()} ${m[2]}`);
  }
  return out;
}

function extractTables(content: string): string[] {
  const out: string[] = [];
  // SQL: CREATE TABLE [IF NOT EXISTS] name (…)
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(m[1] as string);
  }
  return [...new Set(out)];
}

function extractEnvReads(content: string): string[] {
  const out = new Set<string>();
  // process.env["FOO"] / process.env.FOO / process.env['FOO']
  const bracket = /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;
  const dotted = /process\.env\.([A-Z][A-Z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(content)) !== null) out.add(m[1] as string);
  while ((m = dotted.exec(content)) !== null) out.add(m[1] as string);
  // Filter noise — env var names are conventionally upper-snake and >= 3 chars.
  return [...out].filter((n) => n.length >= 3);
}

function extractEmittedEvents(content: string): string[] {
  const out = new Set<string>();
  // Matches: emit("name"), .emit('name.subname'), sendWebhook({ event: "x" })
  const emit = /\bemit\s*\(\s*['"`]([a-z][a-z0-9_.:-]*)['"`]/gi;
  const webhookEvent = /\bevent\s*:\s*['"`]([a-z][a-z0-9_.:-]*)['"`]/gi;
  let m: RegExpExecArray | null;
  while ((m = emit.exec(content)) !== null) out.add(m[1] as string);
  while ((m = webhookEvent.exec(content)) !== null) out.add(m[1] as string);
  return [...out];
}
