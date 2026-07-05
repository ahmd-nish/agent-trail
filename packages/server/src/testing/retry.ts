// PRD_TESTING T1.6 — smart retry classifier.
//
// Old retry policy treated all failures alike: assertion failures got
// retried the same as connection errors. That masks flakes and wastes time
// retrying deterministic failures.
//
// New policy classifies each failed attempt into:
//   retryable_transient — connection refused, DNS, timeout, socket reset
//   retryable_status    — 5xx server error (configurable)
//   assertion_failure   — the request succeeded but the case's assertions
//                          were red; NOT retried by default
//   unrecoverable       — malformed input, missing endpoint, etc.
//
// A case that fails on attempt 1 and passes on attempt 2 is recorded as
// `flaky_pass`, not `pass`. The gate treats flaky_pass as "warn but count as
// pass" — never silent, never blocking on its own.

export type FailureClass =
  | "retryable_transient"
  | "retryable_status"
  | "assertion_failure"
  | "unrecoverable";

const TRANSIENT_ERR_PATTERNS = [
  /econnrefused/i, /enotfound/i, /econnreset/i, /etimedout/i,
  /timeout/i, /aborted/i, /socket hang up/i, /getaddrinfo/i,
  /network error/i, /fetch failed/i,
];

export interface AttemptFailure {
  /** Was the request itself made successfully? */
  requestSent: boolean;
  /** HTTP response status, if the request completed. */
  status?: number;
  /** True when the driver said the run hit its timeout. */
  timedOut?: boolean;
  /** Underlying error string (from fetch/spawn). */
  errorMessage?: string;
  /** Did any assertion fail? Independent of the request outcome. */
  assertionFailed?: boolean;
}

export function classifyFailure(f: AttemptFailure): FailureClass {
  if (f.timedOut) return "retryable_transient";
  if (!f.requestSent) {
    if (f.errorMessage && TRANSIENT_ERR_PATTERNS.some((p) => p.test(f.errorMessage!))) return "retryable_transient";
    return "unrecoverable";
  }
  // Request went out. If the server was 5xx, retry once (server may be
  // warming up, race with a migration, etc.). Below 5xx = fully deterministic.
  if (typeof f.status === "number" && f.status >= 500 && f.status < 600) return "retryable_status";
  if (f.assertionFailed) return "assertion_failure";
  return "unrecoverable";
}

export interface RetryPolicy {
  /** Additional attempts after the first. Default 2. */
  count?: number;
  /** Base delay between attempts in ms. Default 300. */
  baseBackoffMs?: number;
  /** Also retry assertion failures? Off by default — retrying deterministic
   *  assertion fails just wastes time and masks flakes. */
  retryAssertionFailures?: boolean;
}

/**
 * Given an attempt index (0-based) and a policy, return how long to wait
 * before the next attempt. Exponential + jitter to spread thundering herds.
 * Returns 0 when there is no next attempt.
 */
export function backoffDelayMs(
  attemptIndex: number,
  failure: FailureClass,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const maxAttempts = 1 + (policy.count ?? 2);
  if (attemptIndex + 1 >= maxAttempts) return 0;
  if (failure === "unrecoverable") return 0;
  if (failure === "assertion_failure" && !policy.retryAssertionFailures) return 0;
  const base = policy.baseBackoffMs ?? 300;
  const exp = base * 2 ** attemptIndex;
  const jitter = exp * (0.5 + random() * 0.5); // 50–100% of exp
  return Math.round(jitter);
}

export type RunOutcome = "pass" | "flaky_pass" | "fail" | "error";

/**
 * Classify the whole retry loop into an outcome the gate can consume.
 *   - all attempts passed          → pass
 *   - some attempts failed, final passed → flaky_pass
 *   - all attempts failed          → fail (if assertion) / error (if transient)
 */
export function classifyOutcome(attemptResults: Array<{ passed: boolean; failureClass?: FailureClass }>): RunOutcome {
  if (attemptResults.length === 0) return "fail";
  const finalPassed = attemptResults[attemptResults.length - 1]!.passed;
  if (finalPassed && attemptResults.length === 1) return "pass";
  if (finalPassed) return "flaky_pass";
  const lastClass = attemptResults[attemptResults.length - 1]!.failureClass;
  if (lastClass === "retryable_transient" || lastClass === "unrecoverable") return "error";
  return "fail";
}
