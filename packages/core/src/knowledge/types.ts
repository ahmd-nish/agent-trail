// Types for the knowledge_events log — doc §4.1.
//
// The log is the substrate every other primitive (constitution projection,
// risk index, capability contracts, module briefs) is a deterministic fold of.
// Every field on the row is load-bearing:
//   - `type` gates which projection consumes it.
//   - `scope` filters projections to a directory/task/project.
//   - `confidence` re-ranks retrieval (ruling > observed > inferred).
//   - `valid_from` + `superseded_by` gives temporal validity (§3.2 fix).
//   - `content_hash` dedupes on backfill / replay.

/** Human ruling · observed by a deterministic test/tool · LLM inference. */
export type Confidence = "ruling" | "observed" | "inferred";

/** Where the fact applies. `module:<path>` for directory-scoped rules. */
export type Scope = "org" | "project" | `module:${string}` | `task:${string}`;

/** The 8 canonical event types. */
export type EventType =
  | "decision"           // human ruling from a decision ticket
  | "convention"         // team-authored coding rule
  | "gotcha"             // observed pitfall, e.g. "auth token expires after 1h"
  | "failed_attempt"     // verify_tests failure summary
  | "fix"                // the resolution that made a previously-failing case green
  | "artifact_summary"   // post-execution diff/tests summary
  | "steer"              // mid-run redirect from a human
  | "handoff";           // task reassigned to another human owner

export interface KnowledgeEvent {
  id: string;                    // ULID — time-sortable, cross-machine unique
  workspaceId: string;           // 'local' pre-relay; a real workspace once §4.6 lands
  projectId: string;             // usually the repo name / root
  actorKind: "human" | "agent";
  actorId: string;               // stable id — usually git user.email
  actorName: string;             // display name — git user.name
  taskId: string | null;
  executionId: string | null;
  type: EventType;
  scope: Scope;
  subject: string;               // one-line retrievable headline
  body: string;                  // capped ~1200 chars; secrets redacted
  paths: string[];               // file footprint this fact concerns
  confidence: Confidence;
  validFrom: string;             // ISO-8601 UTC
  supersedes: string | null;     // ULID of the event this one replaces
  supersededBy: string | null;   // filled in when a later event supersedes this one
  contentHash: string;           // sha256(type + scope + subject + body); dedupe key
  createdAt: string;             // ISO-8601 UTC — always set by the store
}

/** Fields the caller provides. The store fills in id / hash / dates / supersededBy. */
export type NewKnowledgeEvent = Omit<KnowledgeEvent, "id" | "contentHash" | "createdAt" | "supersededBy"> & {
  id?: string;                   // caller may pin the id for backfill replayability
  validFrom?: string;            // defaults to now
};

// Body caps — resolved deliberately per knowledgelayer-v2 §2 rather than by
// picking whichever number made the test pass.
//
// The tension: a6fd8c0 raised the single cap 1200 -> 4000 so a structured
// capability contract would fit. But 4000 chars is ~1000 tokens, and Band C
// holds SEVERAL events per pack. A flat 4000 lets a handful of prose events
// quietly consume the whole task-pack budget, which is the context bloat this
// layer exists to kill.
//
// The resolution is that the two kinds of body are not the same good. Prose is
// a summary the agent reads *in addition to* the code. A contract is a
// substitute for opening files at all — it is the one body whose size directly
// buys back tool calls. So only contracts earn the larger budget.

/** Prose bodies — §4.1's original spec. Observed events run 300–800 chars. */
export const BODY_CHAR_CAP = 1200;

/** Structured capability contracts (§4.2b) only. ~1000 tokens, and it is spent
 *  to avoid a downstream agent reading the files the contract describes. */
export const CONTRACT_BODY_CHAR_CAP = 4000;

/** True when a body is a serialized CapabilityContract.
 *
 *  Structural check rather than importing from contracts.ts — types.ts is the
 *  leaf of this module's import graph and must stay that way. A body only
 *  claims the larger cap if it actually parses as a contract, so an
 *  oversized prose body cannot smuggle itself past the prose cap. */
export function isContractBody(body: string): boolean {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(body) as { type?: unknown; provides?: unknown };
    return parsed?.type === "capability_contract" && typeof parsed?.provides === "object";
  } catch {
    return false;
  }
}

/** The cap that applies to this body. Only artifact_summary events can carry a
 *  contract, so any other type is held to the prose cap regardless of shape. */
export function bodyCapFor(type: EventType, body: string): number {
  return type === "artifact_summary" && isContractBody(body)
    ? CONTRACT_BODY_CHAR_CAP
    : BODY_CHAR_CAP;
}
