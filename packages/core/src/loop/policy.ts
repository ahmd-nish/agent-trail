// PRD_OPEN_SOURCE §5.1 — Task.loopPolicy.
//
// The TDD gate + §4.5 escalation + §5.3 thrash detection are all
// "loop-engineering" primitives. This module formalizes them so a task can
// declare "iterate up to 3 times, escalate on 2 failures, no thrash gate"
// and the execution manager honors it, without hard-coding numbers.

export type LoopPattern = "single_shot" | "retry" | "pev" | "while_not_done";
export type VerificationCheck = "tests" | "typecheck" | "lint" | "build";

export interface EscalationPolicy {
  /** Fail this many consecutive verify_tests before bumping the tier. */
  escalateAfterFailures: number;
  /** When true, §5.3 short-circuits blind escalation with a decision ticket
   *  once repeated identical failures / zero-diff iterations show up. */
  thrashDetection: boolean;
}

export interface TerminationPolicy {
  /** Hard ceiling on iterations regardless of tier escalation. */
  maxIterations: number;
  /** Optional USD cap. 0 = disabled. */
  maxCostUsd: number;
  /** Optional token cap. 0 = disabled. */
  maxTokens: number;
}

export interface LoopPolicy {
  pattern: LoopPattern;
  verificationStack: VerificationCheck[];
  termination: TerminationPolicy;
  escalation: EscalationPolicy;
}

/** What a task carries (partial, all fields optional; defaults fill the rest). */
export type PartialLoopPolicy = Partial<{
  pattern: LoopPattern;
  verificationStack: VerificationCheck[];
  termination: Partial<TerminationPolicy>;
  escalation: Partial<EscalationPolicy>;
}>;

// Backward-compat defaults: TDD tasks use the existing pev/verify loop with
// §4.5 escalation after 2 failures + §5.3 thrash detection enabled; single-shot
// tasks (implement_only) don't loop at all.

const TDD_DEFAULTS: LoopPolicy = {
  pattern: "pev",
  verificationStack: ["tests"],
  termination: { maxIterations: 5, maxCostUsd: 0, maxTokens: 0 },
  escalation: { escalateAfterFailures: 2, thrashDetection: true },
};

const SINGLE_SHOT_DEFAULTS: LoopPolicy = {
  pattern: "single_shot",
  verificationStack: [],
  termination: { maxIterations: 1, maxCostUsd: 0, maxTokens: 0 },
  escalation: { escalateAfterFailures: Number.MAX_SAFE_INTEGER, thrashDetection: false },
};

export function defaultLoopPolicy(tddEnabled: boolean): LoopPolicy {
  return tddEnabled ? cloneDefaults(TDD_DEFAULTS) : cloneDefaults(SINGLE_SHOT_DEFAULTS);
}

function cloneDefaults(p: LoopPolicy): LoopPolicy {
  return {
    pattern: p.pattern,
    verificationStack: [...p.verificationStack],
    termination: { ...p.termination },
    escalation: { ...p.escalation },
  };
}

/**
 * Merge a task's partial policy over the tddEnabled-based defaults. Missing
 * subfields inherit their default — a task that only specifies
 * `{ escalation: { escalateAfterFailures: 4 } }` still gets the full pev
 * verification stack and thrash detection.
 */
export function resolveLoopPolicy(tddEnabled: boolean, partial: PartialLoopPolicy | null | undefined): LoopPolicy {
  const base = defaultLoopPolicy(tddEnabled);
  if (!partial) return base;
  return {
    pattern: partial.pattern ?? base.pattern,
    verificationStack: partial.verificationStack ?? base.verificationStack,
    termination: { ...base.termination, ...(partial.termination ?? {}) },
    escalation: { ...base.escalation, ...(partial.escalation ?? {}) },
  };
}

/** Safe JSON parse — never throws. Returns null when the string is empty or malformed. */
export function parseLoopPolicy(raw: string | null | undefined): PartialLoopPolicy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as PartialLoopPolicy;
    return null;
  } catch {
    return null;
  }
}
