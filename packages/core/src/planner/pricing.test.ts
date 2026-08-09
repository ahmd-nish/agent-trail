import { describe, test, expect } from "bun:test";
import { PRICING, costForTier, costForTierCacheAware } from "./pricing.ts";

describe("pricing — §4.6", () => {
  test("every tier has an entry", () => {
    expect(PRICING.haiku.inputPerMillion).toBeGreaterThan(0);
    expect(PRICING.sonnet.inputPerMillion).toBeGreaterThan(0);
    expect(PRICING.opus.inputPerMillion).toBeGreaterThan(0);
  });

  test("pricing ladder is monotonic — haiku < sonnet < opus", () => {
    expect(PRICING.haiku.inputPerMillion).toBeLessThan(PRICING.sonnet.inputPerMillion);
    expect(PRICING.sonnet.inputPerMillion).toBeLessThan(PRICING.opus.inputPerMillion);
    expect(PRICING.haiku.outputPerMillion).toBeLessThan(PRICING.sonnet.outputPerMillion);
    expect(PRICING.sonnet.outputPerMillion).toBeLessThan(PRICING.opus.outputPerMillion);
  });

  test("costForTier — 1M/1M on sonnet = input + output rates", () => {
    const cost = costForTier("sonnet", 1_000_000, 1_000_000);
    expect(cost).toBe(PRICING.sonnet.inputPerMillion + PRICING.sonnet.outputPerMillion);
  });

  test("costForTier — null tier defaults to sonnet (planner fallback)", () => {
    expect(costForTier(null,      100_000, 100_000)).toBe(costForTier("sonnet", 100_000, 100_000));
    expect(costForTier(undefined, 100_000, 100_000)).toBe(costForTier("sonnet", 100_000, 100_000));
  });

  test("costForTier — zero tokens = zero cost", () => {
    expect(costForTier("opus", 0, 0)).toBe(0);
  });

  test("routing haiku vs sonnet on same volume — haiku is cheaper", () => {
    const same = 500_000;
    expect(costForTier("haiku", same, same)).toBeLessThan(costForTier("sonnet", same, same));
  });
});

describe("cache-aware cost", () => {
  test("a cache read bills at 0.1x, a cache write at 1.25x", () => {
    const full = costForTierCacheAware("sonnet", { uncachedInputTokens: 1_000_000, outputTokens: 0 });
    const cached = costForTierCacheAware("sonnet", { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    const written = costForTierCacheAware("sonnet", { uncachedInputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000 });
    expect(cached).toBeCloseTo(full * 0.10, 8);
    expect(written).toBeCloseTo(full * 1.25, 8);
  });

  test("a cache-heavy run costs far less than the naive calculation", () => {
    // 250 uncached + 800 cached is the shape §4.4's band structure produces.
    // Billing all 1050 at full rate overstates by ~3x and would make the
    // prompt work look like a regression.
    const naive = costForTier("sonnet", 1050, 90);
    const real = costForTierCacheAware("sonnet", {
      uncachedInputTokens: 250, outputTokens: 90, cacheReadTokens: 800,
    });
    expect(real).toBeLessThan(naive);
    expect(naive / real).toBeGreaterThan(1.5);
  });

  test("with no cache data it matches the plain calculation", () => {
    expect(costForTierCacheAware("opus", { uncachedInputTokens: 500, outputTokens: 200 }))
      .toBeCloseTo(costForTier("opus", 500, 200), 10);
  });
});
