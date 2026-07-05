// PRD_TESTING T4.3 — validate {{env.KEY}} / {{secret.KEY}} placeholders in
// test-case fields against the board's known env keys. Called at save time
// so users see "unknown env key: FOO" before they run the case.

import type { TestCase } from "../../../core/src/types/index.ts";

const PLACEHOLDER_RE = /\{\{(env|secret)[.:]([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

export interface CaseValidationWarning {
  caseId: string;
  field: "path" | "body" | "headers";
  placeholder: string;
  reason: "unknown_env_key";
}

export function validateCases(
  cases: readonly TestCase[],
  knownEnvKeys: ReadonlySet<string>,
): CaseValidationWarning[] {
  const warnings: CaseValidationWarning[] = [];
  for (const tc of cases) {
    scan(tc.id, "path", tc.path ?? "", knownEnvKeys, warnings);
    scan(tc.id, "body", tc.body ?? "", knownEnvKeys, warnings);
    scan(tc.id, "headers", tc.headers ?? "", knownEnvKeys, warnings);
  }
  return warnings;
}

function scan(
  caseId: string,
  field: CaseValidationWarning["field"],
  input: string,
  known: ReadonlySet<string>,
  out: CaseValidationWarning[],
): void {
  if (!input) return;
  PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_RE.exec(input)) !== null) {
    const key = match[2]!;
    if (!known.has(key)) {
      out.push({
        caseId,
        field,
        placeholder: match[0],
        reason: "unknown_env_key",
      });
    }
  }
}
