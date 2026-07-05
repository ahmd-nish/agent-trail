import type { ModelTier } from "../types/index.ts";

/**
 * Static model router — PRD 1.9.
 *
 * A single tier per task keeps costs sane without the user picking a specific
 * model. Concrete Claude model IDs are pinned here so a version bump lands in
 * one file. Kept in sync with `docs/PRD_OPEN_SOURCE.md` §1.9 and the
 * knowledge-cutoff note in system-prompt (Claude 4.X family).
 */
export const MODEL_FOR_TIER: Record<ModelTier, string> = {
  haiku:  "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus:   "claude-opus-4-7",
};

export function resolveModel(
  explicitModel: string | null | undefined,
  tier: ModelTier | null | undefined,
): string | null {
  if (explicitModel && explicitModel.trim()) return explicitModel;
  if (tier) return MODEL_FOR_TIER[tier];
  return null;
}

/**
 * Planner heuristic — pick a starting tier from a task's shape. Runs on the
 * raw task the planner emitted, so signals available: title, description,
 * tddEnabled, reviewKind, priority, component. Deliberately conservative —
 * anything that touches code or tests goes to sonnet; only docs / config /
 * trivial infra land on haiku. Opus is reserved for the router-v2 escalation
 * (§4.5); we never suggest it at plan time.
 */
export function suggestTier(hint: {
  title?: string;
  description?: string;
  tddEnabled?: boolean;
  reviewKind?: string;
  component?: string | null;
}): ModelTier {
  const text = `${hint.title ?? ""} ${hint.description ?? ""} ${hint.component ?? ""}`.toLowerCase();

  // Explicit docs / config / infra signal → haiku.
  const haikuHints = [
    "docs", "documentation", "readme", "changelog",
    "config", "configuration",
    ".env", "dotenv",
    "rename", "cleanup", "chore",
    "seed data", "fixture",
    "prettier", "format", "lint config",
  ];
  const looksDocs = haikuHints.some((k) => text.includes(k));
  if (looksDocs && hint.tddEnabled === false) return "haiku";
  if (looksDocs && (hint.reviewKind === "human" || hint.reviewKind === "none")) return "haiku";

  // Everything with tests or a real deliverable → sonnet.
  return "sonnet";
}
