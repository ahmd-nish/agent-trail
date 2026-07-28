import { describe, expect, test } from "bun:test";
import { isUlid, ulid, ulidTime } from "./ulid.ts";

describe("ULID", () => {
  test("has 26-char Crockford shape and validates", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("timestamp roundtrips within 1ms", () => {
    const t = Date.now();
    const id = ulid(t);
    expect(ulidTime(id)).toBe(t);
  });

  test("is monotonic within one millisecond (CRDT invariant)", () => {
    const t = 1_700_000_000_000;
    const ids = Array.from({ length: 100 }, () => ulid(t));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  test("sorts by time across milliseconds", () => {
    const early = ulid(1_700_000_000_000);
    const late = ulid(1_700_000_001_000);
    expect([early, late].sort()).toEqual([early, late]);
  });

  test("collision-resistant across 10k calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(ulid());
    expect(seen.size).toBe(10_000);
  });

  test("isUlid rejects bad input", () => {
    expect(isUlid("")).toBe(false);
    expect(isUlid("abc")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA!")).toBe(false); // ! not in Crockford
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV0")).toBe(false); // 27 chars
  });
});
