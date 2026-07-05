// PRD_TESTING T1.1 / T1.2 / T1.3 / T1.6 / T1.7 — server-side Test Execution
// Service. The client hands us a case id; the server does everything else:
// template substitution, secret resolution, HTTP request, assertion eval,
// retry classification, run persistence with server-side timestamps and
// secret redaction.
//
// The client never sees a plaintext secret and never asserts a verdict.

import type { Assertion, AssertionResult, TestCase } from "../../../core/src/types/index.ts";
import { evaluateAssertion, type AssertableResponse } from "../../../core/src/testing/assertions.ts";
import { deriveAssertions } from "../../../core/src/testing/legacy-assertions.ts";
import { substitute, type SubstitutionContext } from "./substitute.ts";
import { buildRedactionMap, redact } from "./redact.ts";
import { classifyFailure, backoffDelayMs, classifyOutcome, type FailureClass, type RunOutcome, type RetryPolicy } from "./retry.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS     = 120_000;

export interface ExecutorRequestContext {
  case: TestCase;
  baseUrl?: string;
  /** Board env — plaintext KV. Never sent back to the client. */
  env: Record<string, string>;
  /** Which env keys should be treated as secrets for redaction. */
  boardSecrets: Set<string>;
  /** Prior in-run response for {{prev.*}} — fresh, not persisted. */
  prev?: unknown;
  /** Named prior responses for {{cases.ALIAS.*}}. */
  cases?: Record<string, unknown>;
  /** Overrides for the retry policy on the case. */
  retry?: RetryPolicy;
}

export interface ExecutorResult {
  outcome: RunOutcome;
  attempts: number;
  durationMs: number;
  assertionResults: AssertionResult[];
  /** HTTP status of the FINAL attempt, if any. */
  status?: number;
  /** Parsed JSON of the final attempt's body, when it was valid JSON. */
  responseJson?: unknown;
  /** Redacted, cap-truncated summary suitable for storage. */
  redactedOutput: string;
  /** Failure class of the final attempt (undefined on pass). */
  failureClass?: FailureClass;
  /** When true, all secrets used in the request/output were successfully
   *  redacted from `redactedOutput`. False signals a bug — investigate. */
  redactionApplied: boolean;
  /** Unresolved placeholders — surfaced to the UI as warnings. */
  unresolvedPlaceholders: string[];
}

const MAX_STORED_OUTPUT = 8_000;

export async function executeCase(ctx: ExecutorRequestContext): Promise<ExecutorResult> {
  const t0 = Date.now();
  const subCtx: SubstitutionContext = {
    env: ctx.env,
    boardSecrets: ctx.boardSecrets,
    prev: ctx.prev,
    cases: ctx.cases,
  };

  const retryPolicy: RetryPolicy = {
    count: ctx.retry?.count ?? ctx.case.retry?.count ?? 2,
    baseBackoffMs: ctx.retry?.baseBackoffMs ?? ctx.case.retry?.backoffMs ?? 300,
    retryAssertionFailures: ctx.retry?.retryAssertionFailures ?? false,
  };
  const maxAttempts = 1 + (retryPolicy.count ?? 2);

  const attemptResults: Array<{ passed: boolean; failureClass?: FailureClass }> = [];
  let finalStatus: number | undefined;
  let finalBody = "";
  let finalJson: unknown = undefined;
  let finalAssertions: AssertionResult[] = [];
  let allSecrets: string[] = [];
  let allUnresolved: string[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptResult = await runOneAttempt(ctx.case, subCtx, ctx.baseUrl);
    allSecrets = allSecrets.concat(attemptResult.secretsUsed);
    allUnresolved = allUnresolved.concat(attemptResult.unresolved);

    finalStatus = attemptResult.status;
    finalBody   = attemptResult.body;
    finalJson   = attemptResult.bodyJson;
    finalAssertions = attemptResult.assertionResults;

    attemptResults.push({ passed: attemptResult.passed, failureClass: attemptResult.failureClass });
    if (attemptResult.passed) break;

    const delay = backoffDelayMs(attempt, attemptResult.failureClass ?? "unrecoverable", retryPolicy);
    if (delay === 0) break;
    await new Promise((r) => setTimeout(r, delay));
  }

  const outcome = classifyOutcome(attemptResults);
  const durationMs = Date.now() - t0;

  // Redact + cap the stored output.
  const redactionMap = buildRedactionMap(allSecrets, ctx.env, ctx.boardSecrets);
  const rawSummary = truncate(
    (finalStatus !== undefined ? `HTTP ${finalStatus}\n\n` : "") + finalBody,
    MAX_STORED_OUTPUT,
  );
  const redactedOutput = redact(rawSummary, redactionMap);
  const redactionApplied = allSecrets.every((s) => !redactedOutput.includes(s));

  return {
    outcome,
    attempts: attemptResults.length,
    durationMs,
    assertionResults: finalAssertions,
    status: finalStatus,
    responseJson: finalJson,
    redactedOutput,
    failureClass: attemptResults[attemptResults.length - 1]?.failureClass,
    redactionApplied,
    unresolvedPlaceholders: [...new Set(allUnresolved)],
  };
}

interface AttemptResult {
  passed: boolean;
  status?: number;
  body: string;
  bodyJson?: unknown;
  assertionResults: AssertionResult[];
  failureClass?: FailureClass;
  secretsUsed: string[];
  unresolved: string[];
}

async function runOneAttempt(
  tc: TestCase,
  subCtx: SubstitutionContext,
  baseUrl?: string,
): Promise<AttemptResult> {
  if (tc.kind === "shell") {
    return await runShellAttempt(tc, subCtx);
  }
  return await runHttpAttempt(tc, subCtx, baseUrl);
}

async function runHttpAttempt(
  tc: TestCase,
  subCtx: SubstitutionContext,
  baseUrl?: string,
): Promise<AttemptResult> {
  const method = (tc.method ?? "GET").toUpperCase();
  const pathSub = substitute(tc.path ?? "", subCtx);
  const bodySub = tc.body ? substitute(tc.body, subCtx) : { value: "", secretsUsed: [], unresolved: [] };
  const headersSub = tc.headers ? substitute(tc.headers, subCtx) : { value: "", secretsUsed: [], unresolved: [] };

  const collectedSecrets = [
    ...pathSub.secretsUsed,
    ...bodySub.secretsUsed,
    ...headersSub.secretsUsed,
  ];
  const collectedUnresolved = [
    ...pathSub.unresolved,
    ...bodySub.unresolved,
    ...headersSub.unresolved,
  ];

  const url = joinUrl(baseUrl, pathSub.value);
  const headers = parseHeaders(headersSub.value);
  const timeoutMs = clamp(tc.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);

  const requestOk = { requestSent: false };
  let status: number | undefined;
  let bodyText = "";
  let bodyJson: unknown = undefined;
  let errorMessage: string | undefined;
  let timedOut = false;
  const start = Date.now();

  try {
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (bodySub.value && !["GET", "HEAD"].includes(method)) init.body = bodySub.value;
    const res = await fetch(url, init);
    requestOk.requestSent = true;
    status = res.status;
    bodyText = await res.text();
    try { bodyJson = bodyText ? JSON.parse(bodyText) : undefined; } catch { /* not JSON */ }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" || /timeout/i.test(err.message))) {
      timedOut = true;
    }
  }

  const durationMs = Date.now() - start;

  // Evaluate assertions (typed + derived from legacy fields).
  const assertions: Assertion[] = tc.assertions?.length
    ? tc.assertions
    : deriveAssertions(tc);
  const response: AssertableResponse = { status, headers: lowerKeyed(headers), body: bodyText, bodyJson, durationMs };
  const assertionResults = assertions.map((a) => evaluateAssertion(a, response));
  const assertionFailed = assertionResults.some((r) => !r.passed);
  const passed = requestOk.requestSent && !assertionFailed && status !== undefined && status < 600;

  let failureClass: FailureClass | undefined;
  if (!passed) {
    failureClass = classifyFailure({
      requestSent: requestOk.requestSent,
      status, timedOut, errorMessage,
      assertionFailed,
    });
  }

  return {
    passed,
    status,
    body: bodyText || errorMessage || "",
    bodyJson,
    assertionResults,
    failureClass,
    secretsUsed: collectedSecrets,
    unresolved: collectedUnresolved,
  };
}

async function runShellAttempt(_tc: TestCase, _subCtx: SubstitutionContext): Promise<AttemptResult> {
  // Shell executor is intentionally stubbed for MVP — the existing routes
  // already support runCommand at the task level; case-level shell will be
  // wired in T4.4 alongside setup/teardown. Fail closed so callers can't
  // silently rely on the missing branch.
  return {
    passed: false,
    body: "shell case execution is not yet available server-side",
    assertionResults: [],
    failureClass: "unrecoverable",
    secretsUsed: [],
    unresolved: [],
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function joinUrl(base: string | undefined, path: string): string {
  if (!base) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.trim()) return out;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
      return out;
    } catch { /* fall through to line format */ }
  }
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function lowerKeyed(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n[...output truncated at ${cap} bytes]`;
}
