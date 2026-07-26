import type { ModelTier } from "../types/index.ts";

// PRD_OPEN_SOURCE §4.6 — token/cost pricing table.
// Public list prices as of the Jul 2026 launch; used for the cost dashboard,
// the odometer, and the router-v2 escalation math. Pinned here in one place
// so a price change (or a new tier) is a one-file edit.

export interface TierPricing {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

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
