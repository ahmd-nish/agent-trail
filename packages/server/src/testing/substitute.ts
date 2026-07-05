// PRD_TESTING T1.3 + T1.7 + T4.1 — server-side template substitution.
//
// Supports the following placeholders (case-sensitive):
//   {{env.KEY}}              — board env value (may be a secret)
//   {{env:KEY}}              — same, alt syntax that some existing cases use
//   {{secret.KEY}}           — board env value, explicitly marked as a secret
//                              (fills the redaction map even if the value
//                              isn't in the boardSecrets set)
//   {{prev.PATH}}            — value from the immediately prior case in the
//                              chain; PATH is either a top-level key or a
//                              JSONPath-like expression (`items[0].id`).
//   {{cases.ALIAS.PATH}}     — value from a named prior case in the same run
//                              (T4.1). ALIAS is the case's `label` slug-cased.
//
// Every substitution that came from `boardSecrets` (or `secret.`) is tracked
// so the caller can redact the substituted value from any stored output.

export interface SubstitutionContext {
  /** Board env: key → plaintext value. */
  env: Record<string, string>;
  /** Keys inside `env` whose values are secrets — used to decide which
   *  substitutions get tracked for redaction. */
  boardSecrets: Set<string>;
  /** Prior case's full parsed response (JSON) for `{{prev.*}}` resolution.
   *  Missing = no prior case in the chain. */
  prev?: unknown;
  /** Named prior cases in the same run for `{{cases.ALIAS.PATH}}` (T4.1). */
  cases?: Record<string, unknown>;
}

export interface SubstitutionResult {
  /** The input with every placeholder replaced. */
  value: string;
  /** Concrete strings substituted from secret sources — the caller redacts
   *  these from any output it plans to persist. Empty when nothing secret
   *  was substituted. */
  secretsUsed: string[];
  /** Placeholders that did not resolve — surfaced as warnings to the caller
   *  so the UI can show "unresolved {{env.FOO}}" pre-run. */
  unresolved: string[];
}

const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)(?:[.:]([a-zA-Z0-9_.\-\[\]$]+))?\}\}/g;

export function substitute(input: string, ctx: SubstitutionContext): SubstitutionResult {
  const secretsUsed: string[] = [];
  const unresolved: string[] = [];

  const value = input.replace(PLACEHOLDER_RE, (raw, ns: string, path?: string) => {
    const resolved = resolveOne(ns, path, ctx);
    if (resolved === undefined) {
      unresolved.push(raw);
      return raw;
    }
    if (resolved.secret) secretsUsed.push(resolved.value);
    return resolved.value;
  });

  return { value, secretsUsed, unresolved };
}

interface ResolvedValue { value: string; secret: boolean }

function resolveOne(ns: string, path: string | undefined, ctx: SubstitutionContext): ResolvedValue | undefined {
  if (ns === "env" || ns === "secret") {
    if (!path) return undefined;
    const v = ctx.env[path];
    if (v === undefined) return undefined;
    const isSecret = ns === "secret" || ctx.boardSecrets.has(path);
    return { value: v, secret: isSecret };
  }

  if (ns === "prev") {
    if (ctx.prev === undefined) return undefined;
    const v = digPath(ctx.prev, path ?? "");
    if (v === undefined) return undefined;
    return { value: coerce(v), secret: false };
  }

  if (ns === "cases") {
    // {{cases.alias.path.to.field}} — the alias is the first path segment.
    if (!path || !ctx.cases) return undefined;
    const dot = path.indexOf(".");
    const alias = dot < 0 ? path : path.slice(0, dot);
    const rest  = dot < 0 ? ""   : path.slice(dot + 1);
    const scope = ctx.cases[alias];
    if (scope === undefined) return undefined;
    const v = rest ? digPath(scope, rest) : scope;
    if (v === undefined) return undefined;
    return { value: coerce(v), secret: false };
  }

  return undefined;
}

// Simple dotted-path + bracket-index accessor. Not a full JSONPath — just
// enough to satisfy `items[0].id`-style references from chained cases.
function digPath(value: unknown, path: string): unknown {
  if (!path) return value;
  const parts = path.split(/\.|(?=\[)/).map((p) => p.replace(/^\./, ""));
  let cur: unknown = value;
  for (const rawSeg of parts) {
    if (cur == null) return undefined;
    const bracket = rawSeg.match(/^\[(\d+)\]$/);
    if (bracket) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(bracket[1])];
      continue;
    }
    const [key, idx] = rawSeg.split(/\[(\d+)\]/, 2);
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key!];
    if (idx !== undefined && cur !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx)];
    }
  }
  return cur;
}

function coerce(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  try { return JSON.stringify(v); } catch { return String(v); }
}
