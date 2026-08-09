import type { ModelTier } from "../types/index.ts";

// PRD_OPEN_SOURCE §4.6 — token/cost pricing table.
// Public list prices as of the Jul 2026 launch; used for the cost dashboard,
// the odometer, and the router-v2 escalation math. Pinned here in one place
// so a price change (or a new tier) is a one-file edit.

export interface TierPricing {
  /** USD per 1M uncached input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

/** Cache multipliers (Anthropic list behaviour): a cache READ bills at 0.1x
 *  the input rate, a cache WRITE at 1.25x. Without these the dashboard bills
 *  every cached read at full price — a ~10x overstatement on exactly the
 *  cache-heavy runs §4.4's band structure is designed to produce, which would
 *  make the prompt work look like it made things worse. */
export const CACHE_READ_MULTIPLIER = 0.10;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export const PRICING: Record<ModelTier, TierPricing> = {
  haiku:  { inputPerMillion: 0.80, outputPerMillion:  4.00 },
  sonnet: { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  opus:   { inputPerMillion: 15.0, outputPerMillion: 75.00 },
};

/** Concrete USD cost for a single execution given a tier + token counts. */
export function costForTier(tier: ModelTier | null | undefined, inputTokens: number, outputTokens: number): number {
  const effective = (tier ?? "sonnet") as ModelTier;
  const price = PRICING[effective];
  return (inputTokens / 1_000_000) * price.inputPerMillion
       + (outputTokens / 1_000_000) * price.outputPerMillion;
}


export interface CacheAwareTokens {
  /** Input tokens billed at the full rate (NOT served from cache). */
  uncachedInputTokens: number;
  outputTokens: number;
  /** Input tokens served from cache, billed at 0.1x. */
  cacheReadTokens?: number;
  /** Input tokens written to cache, billed at 1.25x. */
  cacheCreationTokens?: number;
}

/**
 * Cost with the cache breakdown applied.
 *
 * Use this wherever the split is available (executions rows since migration
 * v25). `costForTier` remains correct for rows that never recorded the
 * breakdown — it simply cannot know, and guessing a discount for unmeasured
 * rows would understate cost as badly as ignoring it overstates.
 */
export function costForTierCacheAware(tier: ModelTier | null | undefined, t: CacheAwareTokens): number {
  const price = PRICING[(tier ?? "sonnet") as ModelTier];
  const perM = (n: number) => n / 1_000_000;
  return perM(t.uncachedInputTokens) * price.inputPerMillion
       + perM(t.cacheReadTokens ?? 0) * price.inputPerMillion * CACHE_READ_MULTIPLIER
       + perM(t.cacheCreationTokens ?? 0) * price.inputPerMillion * CACHE_WRITE_MULTIPLIER
       + perM(t.outputTokens) * price.outputPerMillion;
}
