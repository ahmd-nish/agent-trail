/**
 * Pure assertion evaluator. Given an Assertion and a Response, returns an
 * AssertionResult — never throws. All side effects (HTTP calls, parsing the
 * response) happen at the caller; this module only judges.
 *
 * Used by:
 *   - TestRunner.tsx runCase (per API/shell run)
 *   - Phase 4 parallel runner
 *   - Phase 5 protocol-specific runners (WebSocket, SSE, GraphQL)
 *
 * Adding a new assertion kind:
 *   1. Extend the Assertion union in types/index.ts
 *   2. Add a case to the switch below
 *   3. Add a test in assertions.test.ts
 */

import { JSONPath } from "jsonpath-plus";
import type { Assertion, AssertionResult } from "../types/index.ts";

/** What the evaluator sees. Constructed by the caller from a fetch response,
 * shell process result, or websocket message. */
export interface AssertableResponse {
  /** HTTP status code; undefined for shell cases. */
  status?: number;
  /** Lower-cased header map for case-insensitive lookup. */
  headers?: Record<string, string>;
  /** Raw response body as a string. May be huge — assertions slice as needed. */
  body?: string;
  /** Parsed JSON body when the response was valid JSON. Speeds up json_path
   * by avoiding a re-parse per assertion. */
  bodyJson?: unknown;
  /** Wall-clock time for the request/command, in milliseconds. */
  durationMs: number;
  /** Shell exit code; undefined for API cases. */
  exitCode?: number;
}

export function evaluateAssertion(a: Assertion, r: AssertableResponse): AssertionResult {
  switch (a.kind) {
    case "status":
      return {
        label: "Status code",
        passed: r.status === a.equals,
        expected: String(a.equals),
        actual: r.status === undefined ? "(no response)" : String(r.status),
      };

    case "status_in":
      return {
        label: `Status in ${formatList(a.values)}`,
        passed: r.status !== undefined && a.values.includes(r.status),
        expected: formatList(a.values),
        actual: r.status === undefined ? "(no response)" : String(r.status),
      };

    case "header": {
      const headerName = a.name.toLowerCase();
      const value = r.headers?.[headerName] ?? "";
      if (a.equals !== undefined) {
        return {
          label: `Header ${a.name} equals`,
          passed: value === a.equals,
          expected: a.equals,
          actual: value || "(missing)",
        };
      }
      if (a.matches !== undefined) {
        const re = safeRegex(a.matches);
        if (!re) return regexError(`Header ${a.name} matches`, a.matches);
        return {
          label: `Header ${a.name} matches /${a.matches}/`,
          passed: re.test(value),
          expected: `/${a.matches}/`,
          actual: value || "(missing)",
        };
      }
      // No equals or matches — assert presence only.
      return {
        label: `Header ${a.name} present`,
        passed: value.length > 0,
        expected: "(any value)",
        actual: value || "(missing)",
      };
    }

    case "body_contains": {
      const body = r.body ?? "";
      const hit = body.includes(a.text);
      return {
        label: "Body contains",
        passed: hit,
        expected: a.text,
        actual: hit ? "(found)" : "(not in response body)",
      };
    }

    case "body_matches": {
      const re = safeRegex(a.pattern);
      if (!re) return regexError("Body matches", a.pattern);
      const body = r.body ?? "";
      const hit = re.test(body);
      return {
        label: `Body matches /${a.pattern}/`,
        passed: hit,
        expected: `/${a.pattern}/`,
        actual: hit ? "(matched)" : "(no match)",
      };
    }

    case "json_path": {
      // Resolve the path against the parsed JSON. We use bodyJson when
      // available (computed once by the caller), otherwise try to parse here.
      let json = r.bodyJson;
      if (json === undefined && r.body) {
        try { json = JSON.parse(r.body); } catch { /* not JSON */ }
      }
      if (json === undefined) {
        return {
          label: `JSON path ${a.path}`,
          passed: false,
          expected: jsonPathExpectation(a),
          actual: "(body is not valid JSON)",
        };
      }
      let matches: unknown[];
      try {
        matches = JSONPath({ path: a.path, json: json as object, wrap: true });
      } catch (err) {
        return {
          label: `JSON path ${a.path}`,
          passed: false,
          expected: jsonPathExpectation(a),
          actual: `(invalid JSONPath: ${err instanceof Error ? err.message : String(err)})`,
        };
      }
      const found = matches.length > 0 ? matches[0] : undefined;
      // exists assertion
      if (a.exists !== undefined) {
        const present = matches.length > 0 && found !== undefined && found !== null;
        return {
          label: `JSON path ${a.path} ${a.exists ? "exists" : "absent"}`,
          passed: present === a.exists,
          expected: a.exists ? "(present)" : "(absent)",
          actual: present ? formatValue(found) : "(absent)",
        };
      }
      // equals assertion
      if (a.equals !== undefined) {
        const passed = matches.length > 0 && deepEquals(found, a.equals);
        return {
          label: `JSON path ${a.path} equals`,
          passed,
          expected: formatValue(a.equals),
          actual: matches.length === 0 ? "(no match)" : formatValue(found),
        };
      }
      // matches (regex) assertion
      if (a.matches !== undefined) {
        const re = safeRegex(a.matches);
        if (!re) return regexError(`JSON path ${a.path} matches`, a.matches);
        const str = found === undefined ? "" : typeof found === "string" ? found : JSON.stringify(found);
        return {
          label: `JSON path ${a.path} matches /${a.matches}/`,
          passed: matches.length > 0 && re.test(str),
          expected: `/${a.matches}/`,
          actual: matches.length === 0 ? "(no match)" : str,
        };
      }
      // No equals/matches/exists → assert presence (any non-undefined value).
      return {
        label: `JSON path ${a.path} present`,
        passed: matches.length > 0 && found !== undefined,
        expected: "(any value)",
        actual: matches.length === 0 ? "(no match)" : formatValue(found),
      };
    }

    case "response_time_ms":
      return {
        label: `Response time < ${a.lt}ms`,
        passed: r.durationMs < a.lt,
        expected: `< ${a.lt}ms`,
        actual: `${r.durationMs}ms`,
      };

    case "exit_code":
      return {
        label: "Exit code",
        passed: r.exitCode === a.equals,
        expected: String(a.equals),
        actual: r.exitCode === undefined ? "(no exit code)" : String(r.exitCode),
      };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeRegex(pattern: string): RegExp | null {
  try { return new RegExp(pattern); }
  catch { return null; }
}

function regexError(label: string, pattern: string): AssertionResult {
  return {
    label,
    passed: false,
    expected: `/${pattern}/`,
    actual: "(invalid regex)",
  };
}

function jsonPathExpectation(a: Extract<Assertion, { kind: "json_path" }>): string {
  if (a.equals !== undefined) return `equals ${formatValue(a.equals)}`;
  if (a.matches !== undefined) return `matches /${a.matches}/`;
  if (a.exists !== undefined) return a.exists ? "(present)" : "(absent)";
  return "(any value)";
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  return JSON.stringify(v) ?? String(v);
}

function formatList(values: number[]): string {
  return `[${values.join(", ")}]`;
}

/**
 * Structural equality. Sufficient for JSON-shaped data (primitives, arrays,
 * plain objects). Doesn't handle Date / Map / Set — JSON doesn't either.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEquals(v, (b as unknown[])[i]));
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEquals(ao[k], bo[k]));
}
