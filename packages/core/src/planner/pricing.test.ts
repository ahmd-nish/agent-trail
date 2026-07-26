import { describe, test, expect } from "bun:test";
import { PRICING, costForTier } from "./pricing.ts";

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
