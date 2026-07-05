// PRD_TESTING T1.3 — redact secret values from stored output.
//
// Given a chunk of text and the exact strings that were substituted from
// secret sources, replace every occurrence with the placeholder name so the
// stored run history never contains the plaintext secret.
//
// Applies to: response body, headers, error messages, anything persisted in
// `test_case_runs.output`.

export interface RedactionMap {
  /** Map of "the exact substituted value" → "{{env.KEY}}"-style placeholder
   *  to write in its place. Order matters if the same value appears under
   *  multiple keys; use the first insertion. */
  readonly [substituted: string]: string;
}

export function buildRedactionMap(secretsUsed: readonly string[], env: Record<string, string>, boardSecrets: Set<string>): RedactionMap {
  const map: Record<string, string> = {};
  // Prefer the shortest key names in placeholders (usually the semantic name).
  const secretKeys = new Set(secretsUsed);
  for (const [key, value] of Object.entries(env)) {
    if (!boardSecrets.has(key)) continue;
    if (!secretKeys.has(value)) continue;
    if (!value || value.length < 4) continue; // don't redact tiny substrings — too noisy
    if (!(value in map)) map[value] = `{{env.${key}}}`;
  }
  return map;
}

export function redact(input: string, map: RedactionMap): string {
  if (!input) return input;
  const entries = Object.entries(map);
  if (entries.length === 0) return input;
  // Sort by length descending so a longer secret containing a shorter one is
  // redacted first (avoids partial matches leaving a suffix).
  entries.sort((a, b) => b[0].length - a[0].length);
  let out = input;
  for (const [value, placeholder] of entries) {
    out = out.split(value).join(placeholder);
  }
  return out;
}
