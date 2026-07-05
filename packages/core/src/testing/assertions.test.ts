/**
 * Tests for the assertion evaluator. One describe block per assertion kind,
 * plus a cross-cutting block for edge cases (regex errors, missing bodies,
 * non-JSON responses).
 *
 * The evaluator is the contract — runCase / parallel runner / protocol
 * runners all funnel through it, so changes here ripple everywhere.
 */

import { describe, expect, it } from "bun:test";
import type { Assertion } from "../types/index.ts";
import { evaluateAssertion, type AssertableResponse } from "./assertions.ts";

const r = (overrides: Partial<AssertableResponse> = {}): AssertableResponse => ({
  durationMs: 100,
  ...overrides,
});

describe("status assertion", () => {
  it("passes when response status equals expected", () => {
    const a: Assertion = { kind: "status", equals: 201 };
    expect(evaluateAssertion(a, r({ status: 201 })).passed).toBe(true);
  });

  it("fails when response status differs", () => {
    const a: Assertion = { kind: "status", equals: 201 };
    const res = evaluateAssertion(a, r({ status: 500 }));
    expect(res.passed).toBe(false);
    expect(res.actual).toBe("500");
    expect(res.expected).toBe("201");
  });

  it("reports '(no response)' when status is absent (connection failed)", () => {
    const a: Assertion = { kind: "status", equals: 200 };
    const res = evaluateAssertion(a, r({}));
    expect(res.passed).toBe(false);
    expect(res.actual).toBe("(no response)");
  });
});

describe("status_in assertion", () => {
  it("passes when status is in the allowed set", () => {
    const a: Assertion = { kind: "status_in", values: [200, 201, 204] };
    expect(evaluateAssertion(a, r({ status: 204 })).passed).toBe(true);
  });

  it("fails when status is outside the allowed set", () => {
    const a: Assertion = { kind: "status_in", values: [200, 201] };
    expect(evaluateAssertion(a, r({ status: 500 })).passed).toBe(false);
  });
});

describe("header assertion", () => {
  it("passes equals check on a present header (case-insensitive lookup)", () => {
    const a: Assertion = { kind: "header", name: "Content-Type", equals: "application/json" };
    expect(evaluateAssertion(a, r({ headers: { "content-type": "application/json" } })).passed).toBe(true);
  });

  it("fails equals check on a missing header", () => {
    const a: Assertion = { kind: "header", name: "X-Custom", equals: "foo" };
    const res = evaluateAssertion(a, r({ headers: {} }));
    expect(res.passed).toBe(false);
    expect(res.actual).toBe("(missing)");
  });

  it("passes matches check with a regex", () => {
    const a: Assertion = { kind: "header", name: "Server", matches: "^nginx" };
    expect(evaluateAssertion(a, r({ headers: { server: "nginx/1.21.4" } })).passed).toBe(true);
  });

  it("reports invalid regex cleanly", () => {
    const a: Assertion = { kind: "header", name: "X", matches: "[unclosed" };
    const res = evaluateAssertion(a, r({ headers: { x: "v" } }));
    expect(res.passed).toBe(false);
    expect(res.actual).toBe("(invalid regex)");
  });

  it("checks presence when neither equals nor matches given", () => {
    const a: Assertion = { kind: "header", name: "X-Trace-Id" };
    expect(evaluateAssertion(a, r({ headers: { "x-trace-id": "abc" } })).passed).toBe(true);
    expect(evaluateAssertion(a, r({ headers: {} })).passed).toBe(false);
  });
});

describe("body_contains assertion", () => {
  it("passes when substring found", () => {
    const a: Assertion = { kind: "body_contains", text: "hello" };
    expect(evaluateAssertion(a, r({ body: '{"msg":"hello world"}' })).passed).toBe(true);
  });

  it("fails when body is missing", () => {
    const a: Assertion = { kind: "body_contains", text: "x" };
    expect(evaluateAssertion(a, r({})).passed).toBe(false);
  });
});

describe("body_matches assertion", () => {
  it("passes on regex match", () => {
    const a: Assertion = { kind: "body_matches", pattern: '"id"\\s*:\\s*"[a-f0-9-]+"' };
    expect(evaluateAssertion(a, r({ body: '{"id":"abc-123-def"}' })).passed).toBe(true);
  });

  it("fails on no match and reports cleanly", () => {
    const a: Assertion = { kind: "body_matches", pattern: "^DEBUG" };
    expect(evaluateAssertion(a, r({ body: "INFO: ok" })).passed).toBe(false);
  });

  it("reports invalid regex without throwing", () => {
    const a: Assertion = { kind: "body_matches", pattern: "(?<bad" };
    const res = evaluateAssertion(a, r({ body: "x" }));
    expect(res.passed).toBe(false);
    expect(res.actual).toBe("(invalid regex)");
  });
});

describe("json_path assertion", () => {
  const body = JSON.stringify({
    id: "note-1",
    tags: ["work", "urgent"],
    items: [{ name: "a" }, { name: "b" }],
    nested: { deep: { value: 42 } },
  });

  it("passes equals on a string field", () => {
    const a: Assertion = { kind: "json_path", path: "$.id", equals: "note-1" };
    expect(evaluateAssertion(a, r({ body })).passed).toBe(true);
  });

  it("uses pre-parsed bodyJson when provided (perf path)", () => {
    const a: Assertion = { kind: "json_path", path: "$.id", equals: "note-1" };
    const parsed = JSON.parse(body);
    // Passing only bodyJson (no string body) confirms the parsed path is used.
    expect(evaluateAssertion(a, r({ bodyJson: parsed })).passed).toBe(true);
  });

  it("passes equals on a nested deep field", () => {
    const a: Assertion = { kind: "json_path", path: "$.nested.deep.value", equals: 42 };
    expect(evaluateAssertion(a, r({ body })).passed).toBe(true);
  });

  it("passes equals on an array element", () => {
    const a: Assertion = { kind: "json_path", path: "$.tags[0]", equals: "work" };
    expect(evaluateAssertion(a, r({ body })).passed).toBe(true);
  });

  it("passes exists:true when path resolves", () => {
    const a: Assertion = { kind: "json_path", path: "$.items[1].name", exists: true };
    expect(evaluateAssertion(a, r({ body })).passed).toBe(true);
  });

  it("passes exists:false when path does not resolve", () => {
    const a: Assertion = { kind: "json_path", path: "$.nonexistent", exists: false };
    expect(evaluateAssertion(a, r({ body })).passed).toBe(true);
  });

  it("passes matches regex against a string value", () => {
    const a: Assertion = { kind: "json_path", path: "$.id", matches: "^note-\\d+$" };
    expect(evaluateAssertion(a, r({ body })).passed).toBe(true);
  });

  it("fails cleanly when body is not JSON", () => {
    const a: Assertion = { kind: "json_path", path: "$.id", equals: "x" };
    const res = evaluateAssertion(a, r({ body: "not json" }));
    expect(res.passed).toBe(false);
    expect(res.actual).toBe("(body is not valid JSON)");
  });

  it("does not throw on weird path syntax — returns a failing result", () => {
    // jsonpath-plus is permissive and silently returns [] for most malformed
    // paths rather than throwing. The contract we care about is "the
    // evaluator never throws"; correctness of the path is the user's job.
    const a: Assertion = { kind: "json_path", path: "$..[", equals: "x" };
    expect(() => evaluateAssertion(a, r({ body }))).not.toThrow();
    expect(evaluateAssertion(a, r({ body })).passed).toBe(false);
  });

  it("fails equals when the value differs", () => {
    const a: Assertion = { kind: "json_path", path: "$.id", equals: "other" };
    expect(evaluateAssertion(a, r({ body })).passed).toBe(false);
  });

  it("matches deeply on a nested object equals", () => {
    const a: Assertion = { kind: "json_path", path: "$.nested.deep", equals: { value: 42 } };
    expect(evaluateAssertion(a, r({ body })).passed).toBe(true);
  });
});

describe("response_time_ms assertion", () => {
  it("passes when duration is below the threshold", () => {
    const a: Assertion = { kind: "response_time_ms", lt: 500 };
    expect(evaluateAssertion(a, r({ durationMs: 120 })).passed).toBe(true);
  });

  it("fails when duration meets or exceeds the threshold", () => {
    const a: Assertion = { kind: "response_time_ms", lt: 500 };
    expect(evaluateAssertion(a, r({ durationMs: 500 })).passed).toBe(false);
    expect(evaluateAssertion(a, r({ durationMs: 800 })).passed).toBe(false);
  });
});

describe("exit_code assertion", () => {
  it("passes when shell exit code matches", () => {
    const a: Assertion = { kind: "exit_code", equals: 0 };
    expect(evaluateAssertion(a, r({ exitCode: 0 })).passed).toBe(true);
  });

  it("fails when exit code differs and reports actual", () => {
    const a: Assertion = { kind: "exit_code", equals: 0 };
    const res = evaluateAssertion(a, r({ exitCode: 1 }));
    expect(res.passed).toBe(false);
    expect(res.actual).toBe("1");
  });

  it("reports '(no exit code)' when exitCode is undefined", () => {
    const a: Assertion = { kind: "exit_code", equals: 0 };
    expect(evaluateAssertion(a, r({})).actual).toBe("(no exit code)");
  });
});

describe("evaluator never throws", () => {
  // Every test above also implicitly verifies this, but pin the contract
  // explicitly: malformed inputs must return a failing result, not throw.
  it("survives empty response", () => {
    const a: Assertion = { kind: "json_path", path: "$..x", equals: 1 };
    expect(() => evaluateAssertion(a, r({}))).not.toThrow();
  });

  it("survives a JSON path against an empty body string", () => {
    const a: Assertion = { kind: "json_path", path: "$.foo", equals: 1 };
    expect(() => evaluateAssertion(a, r({ body: "" }))).not.toThrow();
  });
});
