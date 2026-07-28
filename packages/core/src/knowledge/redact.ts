// Secret redaction — copied in spirit from projectmem (doc §5.2).
// Runs on every event body BEFORE it hits disk or the wire. Pinned by
// true-positive + false-positive tests so debugging prose isn't mangled.
//
// The threat is not "an agent leaked a secret in production code" — the
// codebase's own review process catches that. It's "an agent's error output
// or diff summary contained a token that ended up in the shared team log,"
// which no reviewer sees and no lint runs against. Redaction on the write
// path is the only correct place to catch it.

const REDACTION_LABEL = "[REDACTED]";

// Each pattern is anchored to something unforgeable (a prefix, a header,
// a shape) so we do NOT match "sk-" in an English sentence. Order matters
// only in that longer more-specific patterns come first.
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Anthropic / OpenAI / Groq / Grok API keys — all share the `sk-…` shape
  // with a specific charset and length. The min-40 length is what stops
  // it from matching `sk-let me think` in prose.
  { name: "sk-key", re: /\bsk-(?:ant-[a-z]+-)?[A-Za-z0-9_\-]{40,}\b/g },
  // GitHub tokens.
  { name: "gh-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  // AWS access key ID (AKIA / ASIA), and secret keys (40 char base64ish).
  { name: "aws-key-id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "aws-secret", re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  // Google API keys — AIza + 35 chars.
  { name: "google-api", re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  // Slack tokens (xox[bpsa]-…).
  { name: "slack", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  // Stripe secret / restricted keys.
  { name: "stripe", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/g },
  // JWT — three base64url segments separated by dots, must start with the
  // {"alg":..} header shape (base64 for `{"alg"` is `eyJhbGci`).
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // PEM-encoded keys — the header line is unforgeable.
  { name: "pem", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
];

export interface RedactResult {
  clean: string;
  hits: Array<{ name: string; count: number }>;
}

export function redact(input: string): RedactResult {
  let clean = input;
  const hits: RedactResult["hits"] = [];
  for (const { name, re } of PATTERNS) {
    // Recreate the regex each call — global regex state carries across calls.
    const rx = new RegExp(re.source, re.flags);
    let count = 0;
    clean = clean.replace(rx, () => {
      count++;
      return REDACTION_LABEL;
    });
    if (count > 0) hits.push({ name, count });
  }
  return { clean, hits };
}
