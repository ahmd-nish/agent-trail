// ULID — 128-bit, 26-char, Crockford base32, time-sortable.
// Doc §4.1 property 2: the ULID's time-sortable + globally unique property
// is what lets us treat the event log as a grow-only set (CRDT for free).
// Two machines that have seen the same set of IDs are in the same state
// regardless of arrival order — the whole reason we do NOT need Yjs/Automerge.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;   // 48 bits of time (10 base32 chars)
const RAND_LEN = 16;   // 80 bits of randomness (16 base32 chars)

let lastTime = 0;
let lastRand: number[] = [];

/**
 * Generate a ULID. Monotonic within a single millisecond: if the caller
 * generates two ULIDs in the same ms, the second one's random bits are
 * incremented so lexical order tracks call order. That property is what
 * makes the log a cursor-based tail instead of needing a sequence number.
 */
export function ulid(now = Date.now()): string {
  const timeStr = encodeTime(now, TIME_LEN);
  let randBytes: number[];

  if (now === lastTime && lastRand.length > 0) {
    // Monotonic bump: increment the last random value as a big-endian int.
    randBytes = incrementBytes([...lastRand]);
  } else {
    randBytes = generateRandBytes(RAND_LEN);
  }

  lastTime = now;
  lastRand = randBytes;
  return timeStr + randBytes.map((b) => CROCKFORD[b]).join("");
}

/** Extract the millisecond timestamp from a ULID. */
export function ulidTime(id: string): number {
  const timeStr = id.slice(0, TIME_LEN);
  let ms = 0;
  for (const ch of timeStr) {
    const val = CROCKFORD.indexOf(ch);
    if (val < 0) throw new Error(`invalid ULID character: ${ch}`);
    ms = ms * 32 + val;
  }
  return ms;
}

/** Validate ULID shape without parsing. */
export function isUlid(s: string): boolean {
  if (s.length !== TIME_LEN + RAND_LEN) return false;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return false;
  return true;
}

function encodeTime(time: number, len: number): string {
  const out: string[] = [];
  let t = time;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = CROCKFORD[t % 32] as string;
    t = Math.floor(t / 32);
  }
  return out.join("");
}

function generateRandBytes(len: number): number[] {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b % 32);
}

function incrementBytes(bytes: number[]): number[] {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const cur = bytes[i] as number;
    if (cur < 31) {
      bytes[i] = cur + 1;
      return bytes;
    }
    bytes[i] = 0;
  }
  // Overflow within the same ms — vanishingly unlikely (would take 2^80
  // ULIDs). Reseed to avoid producing a degenerate all-zero suffix.
  return generateRandBytes(bytes.length);
}
