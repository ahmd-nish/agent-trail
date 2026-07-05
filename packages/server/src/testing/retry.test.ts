import { describe, test, expect } from "bun:test";
import { classifyFailure, classifyOutcome, backoffDelayMs } from "./retry.ts";

// PRD_TESTING T1.6 — retry classifier + flaky_pass state.

describe("classifyFailure", () => {
  test("timeout → retryable_transient", () => {
    expect(classifyFailure({ requestSent: false, timedOut: true, errorMessage: "TimeoutError" }))
      .toBe("retryable_transient");
  });

  test("ECONNREFUSED (request not sent) → retryable_transient", () => {
    expect(classifyFailure({ requestSent: false, errorMessage: "connect ECONNREFUSED 127.0.0.1:5000" }))
      .toBe("retryable_transient");
  });

  test("DNS failure (getaddrinfo) → retryable_transient", () => {
    expect(classifyFailure({ requestSent: false, errorMessage: "getaddrinfo ENOTFOUND api" }))
      .toBe("retryable_transient");
  });

  test("5xx after request sent → retryable_status", () => {
    expect(classifyFailure({ requestSent: true, status: 502 })).toBe("retryable_status");
    expect(classifyFailure({ requestSent: true, status: 599 })).toBe("retryable_status");
  });

  test("4xx + assertion failed → assertion_failure (NOT retried)", () => {
    expect(classifyFailure({ requestSent: true, status: 404, assertionFailed: true }))
      .toBe("assertion_failure");
  });

  test("unknown non-network error before request sent → unrecoverable", () => {
    expect(classifyFailure({ requestSent: false, errorMessage: "invalid URL" })).toBe("unrecoverable");
  });
});

describe("classifyOutcome", () => {
  test("single passing attempt → pass", () => {
    expect(classifyOutcome([{ passed: true }])).toBe("pass");
  });

  test("fail then pass → flaky_pass", () => {
    expect(classifyOutcome([
      { passed: false, failureClass: "retryable_transient" },
      { passed: true },
    ])).toBe("flaky_pass");
  });

  test("assertion fail on every attempt → fail", () => {
    expect(classifyOutcome([
      { passed: false, failureClass: "assertion_failure" },
    ])).toBe("fail");
  });

  test("transient failure only → error", () => {
    expect(classifyOutcome([
      { passed: false, failureClass: "retryable_transient" },
      { passed: false, failureClass: "retryable_transient" },
      { passed: false, failureClass: "retryable_transient" },
    ])).toBe("error");
  });
});

describe("backoffDelayMs", () => {
  test("returns 0 when there is no next attempt (final attempt)", () => {
    expect(backoffDelayMs(1, "retryable_transient", { count: 1 }, () => 0.5)).toBe(0);
  });

  test("returns 0 for unrecoverable", () => {
    expect(backoffDelayMs(0, "unrecoverable", { count: 3 }, () => 0.5)).toBe(0);
  });

  test("returns 0 for assertion_failure unless explicitly enabled", () => {
    expect(backoffDelayMs(0, "assertion_failure", { count: 3 }, () => 0.5)).toBe(0);
    expect(backoffDelayMs(0, "assertion_failure", { count: 3, retryAssertionFailures: true }, () => 0.5))
      .toBeGreaterThan(0);
  });

  test("exponential growth: attempt 1 delay > attempt 0 delay (same jitter)", () => {
    const a0 = backoffDelayMs(0, "retryable_transient", { count: 5, baseBackoffMs: 100 }, () => 1);
    const a1 = backoffDelayMs(1, "retryable_transient", { count: 5, baseBackoffMs: 100 }, () => 1);
    expect(a1).toBeGreaterThan(a0);
  });

  test("jitter keeps the delay within [50%, 100%] of the exp base", () => {
    const min = backoffDelayMs(0, "retryable_transient", { count: 3, baseBackoffMs: 200 }, () => 0);
    const max = backoffDelayMs(0, "retryable_transient", { count: 3, baseBackoffMs: 200 }, () => 1);
    expect(min).toBe(100);   // 50% of 200
    expect(max).toBe(200);   // 100% of 200
  });
});
