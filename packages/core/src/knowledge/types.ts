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

/** Body cap. Doc §4.1 spec was ~1200 chars for prose events. Bumped to
 *  4000 to hold a structured capability contract (§4.2b) as JSON when
 *  extraction succeeds. Prose events are typically 300–800 chars so this
 *  is well above the observed distribution and still bounded. */
export const BODY_CHAR_CAP = 4000;
