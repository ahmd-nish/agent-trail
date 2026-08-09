import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptSecret, decryptSecret, getMasterKey, maskSecret, _resetKeyCache } from "./secrets.ts";

// Use a throwaway directory + key file so the user's real ~/.inventarium/master.key
// is never read or modified by this test.
const tmp = mkdtempSync(join(tmpdir(), "inventarium-secrets-"));
const keyPath = join(tmp, "master.key");

beforeAll(() => {
  process.env["INVENTARIUM_SECRET_KEY_PATH"] = keyPath;
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  delete process.env["INVENTARIUM_SECRET_KEY_PATH"];
});

beforeEach(() => {
  _resetKeyCache();
});

describe("getMasterKey", () => {
  it("generates a 32-byte key on first call and persists it", () => {
    expect(existsSync(keyPath)).toBe(false);
    const key = getMasterKey();
    expect(key.length).toBe(32);
    expect(existsSync(keyPath)).toBe(true);
  });

  it("writes the key file with mode 0600 (owner read/write only)", () => {
    // The generation above created it; check perms.
    const mode = statSync(keyPath).mode & 0o777;
    // Mode 0600 = -rw-------. On non-POSIX systems chmod is best-effort, so
    // we tolerate any subset of 0600 but flag world-readable bits.
    expect(mode & 0o077).toBe(0); // no group/other access
  });

  it("loads the existing key on subsequent calls (round-trip stable)", () => {
    const k1 = getMasterKey();
    _resetKeyCache();
    const k2 = getMasterKey();
    expect(k1.toString("hex")).toBe(k2.toString("hex"));
  });
});

describe("encryptSecret / decryptSecret round-trip", () => {
  it("decrypts back to the original plaintext", () => {
    const orig = "sk-live-AbC_123-XYZ";
    expect(decryptSecret(encryptSecret(orig))).toBe(orig);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const a = encryptSecret("hello");
    const b = encryptSecret("hello");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("hello");
    expect(decryptSecret(b)).toBe("hello");
  });

  it("handles unicode + multi-line strings", () => {
    const orig = "🔐 line one\nline two\nüñíçødé";
    expect(decryptSecret(encryptSecret(orig))).toBe(orig);
  });

  it("handles empty string", () => {
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });
});

describe("decryptSecret tamper detection", () => {
  it("throws when the ciphertext byte is flipped", () => {
    const enc = encryptSecret("real");
    const [v, b64] = enc.split(".");
    const buf = Buffer.from(b64!, "base64");
    // Flip the last byte (in the ciphertext portion).
    buf[buf.length - 1] = (buf[buf.length - 1]! ^ 0xff) & 0xff;
    const tampered = `${v}.${buf.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws when the auth tag is modified", () => {
    const enc = encryptSecret("real");
    const [v, b64] = enc.split(".");
    const buf = Buffer.from(b64!, "base64");
    // Flip a byte inside the tag (offset 12..27).
    buf[15] = (buf[15]! ^ 0x55) & 0xff;
    const tampered = `${v}.${buf.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects an unknown version prefix", () => {
    expect(() => decryptSecret("v99.somethingbogus")).toThrow(/version/i);
  });

  it("rejects malformed input with no separator", () => {
    expect(() => decryptSecret("notavalidblob")).toThrow();
  });

  it("rejects truncated blob (shorter than IV+tag)", () => {
    expect(() => decryptSecret("v1.aaaa")).toThrow(/truncated/i);
  });
});

describe("maskSecret", () => {
  it("masks short values fully", () => {
    expect(maskSecret("abc")).toBe("•••");
    expect(maskSecret("abcdef")).toBe("••••••");
  });

  it("shows prefix + suffix on longer values", () => {
    const masked = maskSecret("sk-live-AbC_123-XYZ");
    expect(masked.startsWith("sk-l")).toBe(true);
    expect(masked.endsWith("YZ")).toBe(true);
    expect(masked).toContain("•");
  });
});
