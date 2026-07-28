// Barrel export for the knowledge module (doc §4.1–§4.2).
export { append, count, getById, hashEvent, list } from "./store.ts";
export type { AppendOptions, AppendResult, ListFilter } from "./store.ts";
export { backfillFromContextDir } from "./backfill.ts";
export type { BackfillReport } from "./backfill.ts";
export { foldConstitution } from "./fold.ts";
export type { FoldConstitutionOptions, FoldedConstitution, FoldedSection } from "./fold.ts";
export { search } from "./search.ts";
export type { SearchHit, SearchOptions } from "./search.ts";
export { buildRiskIndex, formatRiskWarnings } from "./risk.ts";
export type { RiskIndex, RiskIndexOptions, RiskWarning } from "./risk.ts";
export { redact } from "./redact.ts";
export type { RedactResult } from "./redact.ts";
export { isUlid, ulid, ulidTime } from "./ulid.ts";
export {
  KNOWLEDGE_EVENTS_DDL,
  KNOWLEDGE_EVENTS_FTS,
  KNOWLEDGE_EVENTS_FTS_TRIGGERS,
  KNOWLEDGE_EVENTS_INDEXES,
} from "./schema.ts";
export { BODY_CHAR_CAP } from "./types.ts";
export type {
  Confidence,
  EventType,
  KnowledgeEvent,
  NewKnowledgeEvent,
  Scope,
} from "./types.ts";
