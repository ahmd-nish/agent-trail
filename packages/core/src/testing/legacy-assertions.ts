/**
 * Backfill helper: synthesize an Assertion[] from a TestCase's legacy
 * `expectedStatus` / `expectedBodyContains` / `expectedExitCode` fields.
 *
 * The TestCase JSON blob in SQLite carries cases that pre-date Phase 2's
 * typed assertions. Rather than running a destructive migration over the
 * stored JSON (risky, irreversible), we backfill at read time:
 *
 *   - New cases: written with `assertions: [...]`, legacy fields stay null
 *   - Old cases: `assertions` missing → synthesized from legacy fields on
 *     each evaluator call
 *
 * When the user edits an old case via the new UI editor, the new assertion
 * list overwrites the legacy fields entirely (the UI clears them).
 */

import type { Assertion, TestCase } from "../types/index.ts";

/**
 * Returns the assertion list for a test case. Uses the explicit `assertions`
 * field when present and non-empty; otherwise synthesizes a list from the
 * legacy `expectedStatus` / `expectedBodyContains` / `expectedExitCode` fields.
 *
 * Pure — never mutates the case.
 */
export function deriveAssertions(tc: TestCase): Assertion[] {
  if (tc.assertions && tc.assertions.length > 0) return tc.assertions;
  return synthesizeFromLegacy(tc);
}

/**
 * Build an Assertion[] from the deprecated fields. Returns [] when the case
 * has neither legacy nor explicit assertions — the caller (runCase) treats
 * this as "no assertions to check" and marks the case skipped or pending.
 */
export function synthesizeFromLegacy(tc: TestCase): Assertion[] {
  const out: Assertion[] = [];
  if (tc.kind === "api") {
    if (typeof tc.expectedStatus === "number") {
      out.push({ kind: "status", equals: tc.expectedStatus });
    }
    if (typeof tc.expectedBodyContains === "string" && tc.expectedBodyContains.length > 0) {
      out.push({ kind: "body_contains", text: tc.expectedBodyContains });
    }
  } else if (tc.kind === "shell") {
    const code = tc.expectedExitCode ?? 0;
    out.push({ kind: "exit_code", equals: code });
  }
  return out;
}

/**
 * Returns true iff this case carries ONLY legacy fields (no explicit
 * assertions list). Used by the UI to render a "Migrate to assertions"
 * hint on old cases.
 */
export function isLegacyCase(tc: TestCase): boolean {
  if (tc.assertions && tc.assertions.length > 0) return false;
  if (tc.kind === "api") {
    return tc.expectedStatus !== undefined || tc.expectedBodyContains !== undefined;
  }
  return tc.expectedExitCode !== undefined;
}
