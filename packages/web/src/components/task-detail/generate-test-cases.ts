import type { TestCase } from "../../../../core/src/types/index.ts";

/**
 * Heuristic test case generator.
 *
 * Goals (in priority order):
 *   1. Correct method + path — never put `PUT` on a `POST /…` criterion.
 *   2. Sensible body + expected status, even for compound criteria.
 *   3. Response-shape assertions when the criterion describes the response
 *      ("with a UUID id", "with tags: []", "items array", etc.).
 *   4. Sequence support — "DELETE /x and subsequent GET returns 404" expands
 *      to two chained cases.
 *   5. Path-param substitution — `:id` swapped for sensible placeholders
 *      (a missing UUID for 404 tests, a placeholder string for create→read flows).
 *   6. Transparency — every case carries a `notes` field explaining how it
 *      was inferred so the user can spot mishaps.
 *
 * The output is best-effort. The user is expected to edit cases before
 * running them, and the dashboard exposes ▶ Run / 🐛 Backlog / 🤖 Fix now
 * controls for each case.
 */

const SHELL_HINT = /\b(bun install|npm install|yarn install|pip install|cargo|make|docker)\b/i;
const HEAD_LINE = /^([A-Z][a-z]+)/;

interface PartialCase {
  method?: string;
  path?: string;
  status?: number;
  body?: string;
  expectedBodyContains?: string;
  intent: "positive" | "negative" | "verify" | "list" | "unknown";
  /** When true, this case re-uses a prior case's response.id via {{prev.id}}. */
  reusesPriorId?: boolean;
  /** When true, the next case in the sequence should reuse this one's id. */
  marksId?: boolean;
  notes: string[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

// PRD_TESTING T3.3 — heuristic generator output must be self-labeled so a
// human reviewer knows to sanity-check before running. Prefixed to the
// generator's own notes on every case it emits.
const HEURISTIC_PREFIX = "[heuristic guess — review before running]";

export function generateCasesForCriterion(criterion: string, criterionIndex: number): TestCase[] {
  // 1. Shell-shaped criteria (install/build/configure) → one shell case
  if (SHELL_HINT.test(criterion)) {
    const cmd = criterion.match(/^(bun [a-z ]+|npm \S+|yarn \S+|pip install \S+|cargo \S+)/i)?.[1] ?? "# fill in command";
    // Negation matters: "completes without errors" / "exits 0" → expect 0.
    // Only require non-zero when the criterion is explicitly about failure.
    const expectsFailure =
      /\b(?:should\s+(?:fail|error)|must\s+(?:fail|error)|non-?zero\s+exit|returns?\s+(?:non-?zero|exit\s+1))/i.test(criterion);
    return [{
      id: newId(),
      criterionIndex,
      label: shortLabel(criterion),
      kind: "shell",
      command: cmd,
      expectedExitCode: expectsFailure ? 1 : 0,
      notes: `${HEURISTIC_PREFIX} Inferred shell command from "${cmd}". Expects ${expectsFailure ? "non-zero" : "exit 0"} based on criterion phrasing.`,
    }];
  }

  // 2. Parse the criterion into ordered clauses with API intent
  const partials = parseIntoCases(criterion);

  // 3. Lift partials into TestCases. Sequence cases (reusesPriorId) get linked
  //    via dependsOnCaseId.
  const cases: TestCase[] = [];
  let priorId: string | null = null;
  for (const p of partials) {
    const id = newId();
    const tc: TestCase = {
      id,
      criterionIndex,
      label: shortLabel(p.notes[0] ?? criterion),
      kind: "api",
      method: p.method ?? "GET",
      path: p.path ?? "/",
      body: p.body || undefined,
      expectedStatus: p.status ?? guessStatus(p),
      expectedBodyContains: p.expectedBodyContains || undefined,
      notes: `${HEURISTIC_PREFIX} ${p.notes.join(" ")}`,
    };
    if (p.reusesPriorId && priorId) tc.dependsOnCaseId = priorId;
    cases.push(tc);
    if (p.marksId) priorId = id;
  }

  // 4. Fallback: if we couldn't parse anything useful, emit a single placeholder
  //    so the user has a starting point.
  if (cases.length === 0) {
    cases.push({
      id: newId(),
      criterionIndex,
      label: shortLabel(criterion),
      kind: "api",
      method: "GET",
      path: "/",
      expectedStatus: 200,
      notes: `${HEURISTIC_PREFIX} Generator couldn't extract a method/path from the criterion text. Edit this case to match the intent.`,
    });
  }

  return cases;
}

export function blankCase(criterionIndex: number, kind: "api" | "shell" = "api"): TestCase {
  if (kind === "shell") {
    return { id: newId(), criterionIndex, label: "New shell case", kind: "shell", command: "", expectedExitCode: 0 };
  }
  return {
    id: newId(),
    criterionIndex,
    label: "New case",
    kind: "api",
    method: "GET",
    path: "/",
    expectedStatus: 200,
  };
}

// ─── Parsing pipeline ─────────────────────────────────────────────────────────

/**
 * Split a criterion into ordered atomic clauses, then turn each clause into a
 * PartialCase. Inherits method/path across clauses; tracks sequence intent.
 *
 * Notably handles:
 *   - "X; Y"                                → [X, Y]
 *   - "X and subsequent Y"                  → [X (marks id), Y (reuses id)]
 *   - "X, then Y"                           → [X (marks id), Y (reuses id)]
 *   - "X with no fields; with title only"   → [X (no fields), inherits method/path with body]
 */
function parseIntoCases(criterion: string): PartialCase[] {
  const clauses = splitClauses(criterion);
  const partials: PartialCase[] = [];
  let inheritedMethod: string | undefined;
  let inheritedPath: string | undefined;
  let priorIsSetup = false;

  for (let i = 0; i < clauses.length; i++) {
    const { text, marksSetup } = clauses[i]!;
    const mp = extractMethodAndPath(text);
    const method = (mp.method ?? inheritedMethod);
    let path = (mp.path ?? inheritedPath);

    // A clause with no method AND no inherited path is probably descriptive
    // noise inside a criterion (e.g. ", returns a JSON body"). Skip.
    if (!method && !path) continue;

    if (mp.method) inheritedMethod = mp.method;
    if (mp.path) inheritedPath = mp.path;

    const notes: string[] = [];
    // Default label = clause text
    notes.push(`From clause "${text.length > 70 ? text.slice(0, 69) + "…" : text}".`);
    if (!mp.method && inheritedMethod) notes.push(`Method inherited from a previous clause (${inheritedMethod}).`);
    if (!mp.path && inheritedPath) notes.push(`Path inherited from a previous clause (${inheritedPath}).`);

    // Path-parameter substitution
    if (path && /:[a-zA-Z_]+/.test(path)) {
      const newPath = applyPathParamSubstitution(path, text, priorIsSetup);
      if (newPath !== path) notes.push(`Substituted path parameter (${path} → ${newPath}).`);
      path = newPath;
    }

    const status = extractStatus(text);
    const body = inferBody(text, method);
    const bodyAssertion = extractBodyAssertion(text);
    const intent = classifyIntent(text);

    if (body) notes.push(`Body inferred from text shape (${bodySource(text, body)}).`);
    if (bodyAssertion) notes.push(`Response assertion: must contain ${JSON.stringify(bodyAssertion)}.`);

    const reusesPriorId = priorIsSetup || /(subsequent|then)\b/i.test(text);
    if (reusesPriorId) notes.push("Sequence: reuses the id from the previous case.");

    partials.push({
      method, path, status, body,
      expectedBodyContains: bodyAssertion,
      intent,
      reusesPriorId,
      marksId: marksSetup,
      notes,
    });

    priorIsSetup = marksSetup;
  }

  // Special case: the first clause is "POST … returns 201" AND the criterion
  // explicitly mentions response shape ("with a UUID id and tags: []") —
  // append a separate "verify response shape" case so the assertion is
  // distinct from the create case.
  if (partials.length === 1 && partials[0]!.intent === "positive") {
    const extra = extractBodyAssertion(criterion);
    if (extra && partials[0]!.expectedBodyContains !== extra) {
      partials[0]!.expectedBodyContains = extra;
      partials[0]!.notes.push("(Body assertion appended from the post-status clause.)");
    }
  }

  return partials;
}

interface ParsedClause { text: string; marksSetup: boolean; }

/**
 * Split a criterion into atomic clauses. Returns each with a flag indicating
 * whether the clause "creates state" for a subsequent clause to reuse.
 *
 * The split markers are: `;`, `, then`, ` and then`, ` and subsequent`.
 * Everything else (notably " and " alone) is left intact so phrases like
 * "title and body" stay together.
 */
function splitClauses(text: string): ParsedClause[] {
  const out: ParsedClause[] = [];
  for (const segment of text.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    // Splits on sequence-markers — the part BEFORE the marker is considered
    // setup, the part AFTER is the verification step.
    const re = /(?:,\s*then\s+|\s+and\s+(?:subsequent\s+|then\s+))/i;
    const parts: string[] = trimmed.split(re).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1) {
      out.push({ text: parts[0]!, marksSetup: false });
    } else {
      // First part is "setup" (creates/deletes), the rest verify
      out.push({ text: parts[0]!, marksSetup: true });
      for (let i = 1; i < parts.length; i++) {
        out.push({ text: parts[i]!, marksSetup: false });
      }
    }
  }
  return out;
}

function extractMethodAndPath(clause: string): { method?: string; path?: string } {
  // Prefer "METHOD /path" but tolerate slight noise:
  //   "POST /notes"
  //   "POST /notes/:id"
  //   "GET /notes?q=…"
  const m = clause.match(/\b(GET|POST|PUT|PATCH|DELETE)\b\s+(\/\S+)/i);
  if (!m) return {};
  let path = m[2]!;
  // Strip trailing punctuation that isn't part of the URL.
  path = path.replace(/[.,;:!?)\]}>"']+$/, "");
  return { method: m[1]!.toUpperCase(), path };
}

// PRD_TESTING T0.3 — only treat a 1xx–5xx number as an HTTP status when a
// status-y word sits adjacent to it. Prevents "create 500 notes" from being
// misread as "expects 500". Words are matched within a small window (≤ 20
// chars) on either side; the regex covers the common phrasings and arrow
// notation from PRDs.
const STATUS_WORDS = "returns?|responds?|expects?|status(?:\\s*code)?|http|resp\\.?status";
const STATUS_TAIL  = "status|response|ok|created|no\\s*content|bad\\s*request|unauthorized|forbidden|not\\s*found|conflict|error";
const FILLER       = "(?:\\s*(?:with|a|the|of|to)\\s+)?";
const STATUS_CONTEXT = new RegExp(
  // "<word> <filler> 200"  OR  "=> / → / -> 200"  OR  "200 <tail>"
  `(?:${STATUS_WORDS})${FILLER}[:=]?\\s*(\\d{3})|(?:=>|\\u2192|->)\\s*(\\d{3})|(\\d{3})\\s+(?:${STATUS_TAIL})`,
  "i",
);

export function extractStatus(clause: string): number | undefined {
  const m = clause.match(STATUS_CONTEXT);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!raw) return undefined;
  const n = Number(raw);
  return n >= 100 && n < 600 ? n : undefined;
}

function guessStatus(p: PartialCase): number {
  // Method-conventional defaults if the criterion didn't say.
  if (p.intent === "negative") return 400;
  if (p.method === "POST") return 201;
  if (p.method === "DELETE") return 204;
  return 200;
}

function classifyIntent(text: string): PartialCase["intent"] {
  const lower = text.toLowerCase();
  if (/(invalid|empty|missing|reject|fails?|400|404|409|conflict|duplicate)/.test(lower)) return "negative";
  if (/(returns?\s+\d{3}|returns?\s+(a|the)|create|created|update|updated|delete|deleted)/.test(lower)) return "positive";
  if (/(list|returns?\s+(items|notes|tags|array)|paginat)/.test(lower)) return "list";
  if (/(verif|confirm|then|subsequent|cascade)/.test(lower)) return "verify";
  return "unknown";
}

// ─── Body inference ───────────────────────────────────────────────────────────

interface BodyInference { body: string; reason: string; }

function inferBody(clause: string, method: string | undefined): string {
  return inferBodyWithReason(clause, method).body;
}

function bodySource(clause: string, body: string): string {
  return inferBodyWithReason(clause, body ? "POST" : undefined).reason;
}

function inferBodyWithReason(clause: string, method: string | undefined): BodyInference {
  if (!method || method === "GET" || method === "DELETE" || method === "HEAD") return { body: "", reason: "(none — method has no body)" };
  const lower = clause.toLowerCase();

  // Resource-specific shortcuts — these match common API shapes well.
  const TAG_NAMED = clause.match(/['"]([a-z0-9_-]+)['"]/i);

  if (/no\s+fields|empty\s+(request|body|payload)|no\s+payload/.test(lower))
    return { body: "{}", reason: "criterion mentions no fields / empty body" };
  // Note: "empty title" check covers compound phrasings like "empty or missing
  // title" (we generate the explicit empty-string case) AND must be checked
  // BEFORE the bare "missing title" branch.
  if (/empty\s+(?:\w+\s+)*title/.test(lower))
    return { body: JSON.stringify({ title: "" }), reason: "criterion mentions empty title" };
  if (/missing\s+title/.test(lower))
    return { body: JSON.stringify({ body: "Hello world" }), reason: "criterion mentions missing title (so omit it)" };
  if (/empty\s+body/.test(lower))
    return { body: JSON.stringify({ title: "Test note", body: "" }), reason: "criterion mentions empty body field" };
  if (/title\s+only|only\s+title/.test(lower))
    return { body: JSON.stringify({ title: "Updated title" }), reason: "criterion mentions title-only update" };
  if (/body\s+only|only\s+body/.test(lower))
    return { body: JSON.stringify({ body: "Updated body content" }), reason: "criterion mentions body-only update" };
  if (/invalid\s+(json|payload|body)/.test(lower))
    return { body: "{not valid json", reason: "criterion mentions invalid JSON" };

  // Tag-shaped criteria
  if (/with\s+name|new\s+tag|tag\s+named|existing\s+name/.test(lower))
    return { body: JSON.stringify({ name: TAG_NAMED?.[1] ?? "work" }), reason: "criterion mentions tag name" };
  if (/attach\s+a\s+tag|new\s+tag/.test(lower))
    return { body: JSON.stringify({ name: "work" }), reason: "criterion mentions attaching a tag" };

  // Default positive payload — heuristic guess at the resource shape from path
  if (/notes?/.test(lower))
    return { body: JSON.stringify({ title: "Test note", body: "Hello world" }), reason: "notes-shaped resource" };
  if (/tags?/.test(lower))
    return { body: JSON.stringify({ name: "work" }), reason: "tags-shaped resource" };

  return { body: "", reason: "no body inferred — fill in manually" };
}

// ─── Response assertions ──────────────────────────────────────────────────────

/**
 * Extract a snippet the response body must contain. Looks for JSON-shaped
 * fragments in the criterion text:
 *   "with tags: []"                       → `"tags":[]`
 *   "returns a UUID id"                   → `"id":"`
 *   "items array and total reflects…"     → `"items":[`
 *   "{ \"items\": [...], \"total\": 42 }" → first key/value
 */
function extractBodyAssertion(text: string): string | undefined {
  // Literal JSON snippet `key: value` → `"key":value`
  const kv = text.match(/(['"]?)([a-zA-Z_][a-zA-Z0-9_]*)\1\s*:\s*(\[\s*\]|\{\s*\}|true|false|null|\d+|"[^"]*")/);
  if (kv) {
    const key = kv[2]!;
    const val = kv[3]!.replace(/\s+/g, "");
    return `"${key}":${val}`;
  }
  // "with a UUID id" / "with an id"
  if (/\b(uuid\s+id|a\s+uuid|with\s+an?\s+id)\b/i.test(text)) return `"id":"`;
  // "items array"
  if (/\bitems\s+array\b/i.test(text)) return `"items":[`;
  // "click count" / "clicks"
  if (/\bclicks?\s+count\b|\bclicks?\b/i.test(text)) return `"clicks"`;
  return undefined;
}

// ─── Path parameter substitution ──────────────────────────────────────────────

function applyPathParamSubstitution(path: string, clause: string, priorIsSetup: boolean): string {
  // If this is a verify-step in a sequence (a previous case marked state),
  // substitute params with a templating placeholder the runner can swap in.
  if (priorIsSetup) {
    return path.replace(/:([a-zA-Z_]+)/g, (_m, name) => `{{prev.${name}}}`);
  }

  const lower = clause.toLowerCase();
  // "non-existent" → known-missing UUID-shaped string
  if (/non-?existent|missing|unknown|not\s+found|404/.test(lower)) {
    return path.replace(/:[a-zA-Z_]+/g, "00000000-0000-0000-0000-000000000000");
  }
  // Otherwise leave the placeholder so the user fills it in
  return path;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function shortLabel(s: string, max = 80): string {
  const t = s.replace(/^From clause\s*"/, "").replace(/"\.?\s*$/, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Runtime substitution for `{{prev.<key>}}` and `{{env.<KEY>}}` placeholders.
 *
 *   {{prev.X}} — value from the previous case's response JSON (UNTRUSTED, escaped)
 *   {{env.X}}  — value from board_env (trusted at storage time, still escaped
 *                because the test target is untrusted)
 *
 * Modes:
 *   "url"  → encodeURIComponent for safe path/query interpolation
 *   "json" → JSON.stringify (sans wrapping quotes) so it fits inside an
 *            existing JSON string; booleans/numbers/null emitted verbatim
 *   "raw"  → no escaping (legacy + previews)
 *
 * The optional `env` arg provides the env-var map. Unresolved placeholders
 * stay literal and are reported via `findUnresolvedTemplates` for warning UI.
 */
export type TemplateMode = "url" | "json" | "raw";

export interface TemplateContext {
  prev?: Record<string, unknown>;
  env?: Record<string, string>;
}

export function applyTemplate(
  value: string,
  ctxOrPrev: Record<string, unknown> | TemplateContext,
  mode: TemplateMode = "raw",
): string {
  // Back-compat: callers used to pass `Record<string, unknown>` as `prev`.
  // If the arg has `prev` or `env` keys, treat it as TemplateContext; else
  // wrap it as the prev map. (Same heuristic the tests rely on.)
  const ctx: TemplateContext =
    ctxOrPrev && typeof ctxOrPrev === "object" && ("prev" in ctxOrPrev || "env" in ctxOrPrev)
      ? (ctxOrPrev as TemplateContext)
      : { prev: ctxOrPrev as Record<string, unknown> };

  // Replace prev tokens
  let out = value.replace(/\{\{prev\.([a-zA-Z_]+)\}\}/g, (_m, key) => {
    const v = ctx.prev?.[key];
    if (v === undefined) return `{{prev.${key}}}`;
    return escapeForMode(v, mode);
  });
  // Replace env tokens (keys allow uppercase + digits; env vars are usually SHOUTY_SNAKE)
  out = out.replace(/\{\{env\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_m, key) => {
    const v = ctx.env?.[key];
    if (v === undefined) return `{{env.${key}}}`;
    return escapeForMode(v, mode);
  });
  return out;
}

/**
 * Scan a string for any `{{prev.X}}` / `{{env.X}}` tokens that did NOT
 * resolve against the given context. The UI uses this to warn the user that
 * their request was sent with literal placeholders embedded.
 */
export function findUnresolvedTemplates(value: string, ctx: TemplateContext): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/\{\{(prev|env)\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
    const [, ns, key] = m;
    const map = ns === "prev" ? ctx.prev : ctx.env;
    if (!map || map[key!] === undefined) out.push(`{{${ns}.${key}}}`);
  }
  return out;
}

function escapeForMode(v: unknown, mode: TemplateMode): string {
  if (mode === "raw") return String(v);
  if (mode === "url") return encodeURIComponent(String(v));
  // mode === "json": let JSON.stringify handle quoting + escaping. For strings
  // we strip the outer quotes so the placeholder can live inside an already-
  // quoted JSON value like `"id": "{{prev.id}}"`. Other types serialize raw.
  if (typeof v === "string") {
    const json = JSON.stringify(v);
    return json.slice(1, -1);
  }
  return JSON.stringify(v);
}
