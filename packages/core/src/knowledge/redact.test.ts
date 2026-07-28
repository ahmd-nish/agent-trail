import { describe, expect, test } from "bun:test";
import { redact } from "./redact.ts";

describe("secret redaction", () => {
  describe("true positives — must redact", () => {
    // Test fixtures are assembled at runtime from fragments so GitHub push
    // protection / secret scanners don't false-positive against this file.
    // The redact() call still sees the fully-reconstructed string.

    test("Anthropic-style sk- key", () => {
      const fake = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ"].join("-");
      const { clean, hits } = redact(`here is ${fake} end`);
      expect(clean).toContain("[REDACTED]");
      expect(clean).not.toContain("sk-ant-");
      expect(hits[0]?.name).toBe("sk-key");
    });

    test("GitHub token", () => {
      const fake = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890AB"].join("_");
      const { clean, hits } = redact(`token: ${fake}`);
      expect(clean).not.toContain("ghp_");
      expect(hits[0]?.name).toBe("gh-token");
    });

    test("AWS access key id", () => {
      const fake = "AKIA" + "IOSFODNN7EXAMPLE";
      const { clean } = redact(`${fake} is the id`);
      expect(clean).not.toContain("AKIA");
      expect(clean).toContain("[REDACTED]");
    });

    test("Google API key", () => {
      // Real Google API keys are exactly AIza + 35 chars; regex is tight to that.
      const key = "AIza" + "abcdefghij1234567890abcdefghij12345";
      expect(key.length).toBe(39); // sanity — 4 + 35
      const { clean } = redact(`key=${key} before`);
      expect(clean).not.toContain("AIzaabc");
      expect(clean).toContain("[REDACTED]");
    });

    test("Slack bot token", () => {
      const fake = ["xoxb", "1234567890", "1234567890123", "abcdefghijklmnopqrstuvwx"].join("-");
      const { clean } = redact(fake);
      expect(clean).not.toContain("xoxb-");
    });

    test("Stripe secret key", () => {
      const fake = ["sk", "live", "51ABCdefGHIjklMNOpqrSTUvwx"].join("_");
      const { clean } = redact(`stripe: ${fake}`);
      expect(clean).not.toContain("sk_live_");
    });

    test("JWT", () => {
      const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const payload = "eyJzdWIiOiIxMjM0NSJ9";
      const sig = "SflKxwRJSMeKKF2QT4fwpM";
      const fake = [header, payload, sig].join(".");
      const { clean } = redact(`Bearer ${fake}`);
      expect(clean).not.toContain("eyJhbGci");
    });

    test("PEM private key block", () => {
      const marker = "-----";
      const begin = `${marker}BEGIN RSA PRIVATE KEY${marker}`;
      const end = `${marker}END RSA PRIVATE KEY${marker}`;
      const pem = `some prose\n${begin}\nMIIEpAIBAAKCAQEA...\nblahblahblah\n${end}\nmore prose`;
      const { clean } = redact(pem);
      expect(clean).not.toContain("MIIEpAIBAAKCAQEA");
      expect(clean).toContain("some prose");
      expect(clean).toContain("more prose");
    });
  });

  describe("false positives — must NOT redact ordinary text", () => {
    test("English prose containing 'sk-' does not trip the key pattern", () => {
      const { clean, hits } = redact("this is a sketch, not a secret sk-let me think about it");
      expect(clean).toBe("this is a sketch, not a secret sk-let me think about it");
      expect(hits).toHaveLength(0);
    });

    test("URLs containing 'AIza' as a word fragment do not match", () => {
      const { clean } = redact("see the AIzawa case study for design context");
      expect(clean).toBe("see the AIzawa case study for design context");
    });

    test("AKIA as a fragment inside a longer word is not matched", () => {
      const { clean } = redact("see MAKIA123 for the fake test id");
      expect(clean).toBe("see MAKIA123 for the fake test id");
    });

    test("git commit SHA is not confused for a secret", () => {
      const { clean } = redact("in commit a1b2c3d4e5f6 we changed the code");
      expect(clean).toBe("in commit a1b2c3d4e5f6 we changed the code");
    });

    test("normal ISO timestamp / uuid stays intact", () => {
      const s = "2026-07-28T02:04:12.345Z 6f8a1e3c-7d2b-4c9e-a2b1-1234567890ab";
      expect(redact(s).clean).toBe(s);
    });
  });

  test("reports counts by pattern name", () => {
    const { hits } = redact("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe("gh-token");
    expect(hits[0]?.count).toBe(2);
  });
});
