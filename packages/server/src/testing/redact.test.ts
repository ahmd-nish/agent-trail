import { describe, test, expect } from "bun:test";
import { buildRedactionMap, redact } from "./redact.ts";

// PRD_TESTING T1.3 — secret redaction. Values substituted from board_env
// (with the key marked as a secret) must never appear in stored output.

describe("redact", () => {
  test("replaces substituted secret with its placeholder", () => {
    const env = { API_KEY: "sk_live_abcdefghijkl" };
    const secrets = new Set(["API_KEY"]);
    const map = buildRedactionMap(["sk_live_abcdefghijkl"], env, secrets);
    const before = "Response body: token=sk_live_abcdefghijkl,user=1";
    const after = redact(before, map);
    expect(after).toBe("Response body: token={{env.API_KEY}},user=1");
  });

  test("longer secrets are redacted first — prevents partial-match residue", () => {
    const env = { SHORT: "abcd", LONG: "abcdef" };
    const secrets = new Set(["SHORT", "LONG"]);
    const map = buildRedactionMap(["abcd", "abcdef"], env, secrets);
    // If SHORT were redacted first the "abcdef" would become "{{env.SHORT}}ef".
    expect(redact("payload: abcdef", map)).toBe("payload: {{env.LONG}}");
    expect(redact("payload: abcd", map)).toBe("payload: {{env.SHORT}}");
  });

  test("tiny values (<4 chars) are NOT redacted — too noisy", () => {
    const env = { NUM: "42" };
    const secrets = new Set(["NUM"]);
    const map = buildRedactionMap(["42"], env, secrets);
    expect(map["42"]).toBeUndefined();
    // Actual body would still contain "42" — safer than blanketing every "42".
  });

  test("non-secret substitutions do NOT get redacted", () => {
    const env = { PUBLIC_URL: "https://public.example.com" };
    const secrets = new Set<string>(); // PUBLIC_URL not a secret
    const map = buildRedactionMap(["https://public.example.com"], env, secrets);
    expect(map).toEqual({});
  });

  test("empty input passes through", () => {
    expect(redact("", { a: "b" })).toBe("");
    expect(redact("hello", {})).toBe("hello");
  });
});
