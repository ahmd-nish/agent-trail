/**
 * Secret encryption for board environment variables (Phase 3b).
 *
 * Uses AES-256-GCM with a master key stored at ~/.agent-trail/master.key
 * (file mode 0600). On first use, the key is generated and persisted.
 *
 * Each encrypted value embeds its own random IV — same plaintext encrypts to
 * different ciphertext, and tampering with any byte makes decryption fail
 * (GCM auth tag).
 *
 * Wire format (base64-encoded):  v1.<base64(iv | tag | ciphertext)>
 *   - v1                : version prefix; lets us migrate to a new cipher later
 *   - iv  (12 bytes)    : random per-value
 *   - tag (16 bytes)    : GCM auth tag
 *   - ciphertext (N b)  : plaintext encrypted with the master key
 */

import { createCipheriv, createDecipheriv, randomBytes, type CipherGCM, type DecipherGCM } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

const STATE_DIR = join(homedir(), ".agent-trail");
const KEY_PATH = join(STATE_DIR, "master.key");

let cachedKey: Buffer | null = null;

/**
 * Load (or, on first call, generate + persist) the master key. The key file
 * is chmod'd to 0600 so only the user who created it can read it.
 *
 * Override the location via AGENT_TRAIL_SECRET_KEY_PATH for tests.
 */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const keyPath = process.env["AGENT_TRAIL_SECRET_KEY_PATH"] ?? KEY_PATH;
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf-8").trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== KEY_BYTES) {
      throw new Error(`[secrets] master key at ${keyPath} is ${buf.length} bytes, expected ${KEY_BYTES}. Delete it to regenerate (existing secrets will be unreadable).`);
    }
    cachedKey = buf;
    return buf;
  }
  // Generate + persist with restrictive permissions.
  try { mkdirSync(dirname(keyPath), { recursive: true }); } catch { /* exists */ }
  const newKey = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, newKey.toString("base64"), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best effort on non-POSIX */ }
  cachedKey = newKey;
  return newKey;
}

/** Reset cached key — only used in tests. */
export function _resetKeyCache(): void {
  cachedKey = null;
}

/**
 * Encrypt a plaintext string. Returns a self-contained, base64-prefixed
 * ciphertext that can be stored verbatim in the DB.
 */
export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv) as CipherGCM;
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, ciphertext]);
  return `${VERSION}.${blob.toString("base64")}`;
}

/**
 * Decrypt a value previously produced by encryptSecret(). Throws on any
 * tamper / corruption (GCM rejects modified ciphertext, IV, or tag).
 */
export function decryptSecret(encoded: string): string {
  const sepIdx = encoded.indexOf(".");
  if (sepIdx <= 0) throw new Error(`[secrets] malformed ciphertext (missing version separator)`);
  const version = encoded.slice(0, sepIdx);
  if (version !== VERSION) {
    throw new Error(`[secrets] unsupported ciphertext version "${version}" (expected "${VERSION}")`);
  }
  const blob = Buffer.from(encoded.slice(sepIdx + 1), "base64");
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error(`[secrets] truncated ciphertext (${blob.length} bytes)`);
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const key = getMasterKey();
  const decipher = createDecipheriv(ALG, key, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf-8");
}

/**
 * Mask a secret value for display. Shows first 4 chars + ellipsis + last 2
 * for keys/tokens long enough to be recognizable; full mask for short values.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 6) return "•".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}${"•".repeat(Math.max(4, plaintext.length - 6))}${plaintext.slice(-2)}`;
}
