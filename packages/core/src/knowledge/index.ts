// Barrel export for the knowledge module (doc §4.1–§4.2).
export { append, count, getById, hashEvent, list } from "./store.ts";
export type { AppendOptions, AppendResult, ListFilter } from "./store.ts";
export { backfillFromContextDir } from "./backfill.ts";
export type { BackfillReport } from "./backfill.ts";
export { extractContract, extractFileSymbols, renderContract } from "./contracts.ts";
export type { CapabilityContract, ExportKind, ExportSig, ExtractContractInput } from "./contracts.ts";
// §3.1 — the code-index adapter seam. `native` is always available (rule 2).
export {
  NativeCodeIndex, fileUrn, leafUrn, moduleUrn, parseUrn, pathUrns,
  resolveCodeIndex, symbolUrn, toPosixPath,
} from "./code-index.ts";
export type { CodeIndex, NativeCodeIndexOptions, ParsedUrn, SymbolKind, SymbolRef } from "./code-index.ts";
export { changedFileCorpus, formatBenchReport, runCodeIndexBench } from "./code-index-bench.ts";
// §J — the join between asserted knowledge and derived code structure.
export {
  appendEdge, blastRadius, emitContractEdges, emitPathEdges, eventUrn,
  formatGoverningHits, hasEdgeTable, hashEdge, knowledgeGoverning,
  provenanceChain, resolveSymbolEdges,
} from "./edges.ts";
export type {
  EdgeKind, GoverningHit, GoverningOptions, KnowledgeEdge,
  NewKnowledgeEdge, ProvenanceLink,
} from "./edges.ts";
// §4.2e — git as the validity oracle. Staleness is derived, never recorded.
export {
  checkContractValidity, formatValidityWarning, gitHeadSha, hashEntries,
  rederiveContract, resolveSignatureSet,
} from "./validity.ts";
export type { SignatureSet, ValidityReport, ValidityStatus } from "./validity.ts";
export { hooksDir, installPostMergeHook, uninstallPostMergeHook } from "./hooks.ts";
export type { HookInstallResult } from "./hooks.ts";
// §6 — hybrid retrieval (lexical ∪ structural) and the Band B projections.
export { formatRetrievedFacts, retrieveForTask } from "./retrieval.ts";
export type { RetrievalOptions, RetrievedFact, SeedSource } from "./retrieval.ts";
export { projectModuleBriefs, projectObsidianVault, projectProjectMap } from "./projections.ts";
export type { ModuleBrief, ProjectMap, ProjectionOptions, VaultNote } from "./projections.ts";
// §4.4 — the three-band prompt. Bands A+B must be byte-stable across spawns.
export { EMPTY_BANDS, assemblePrompt, bandSizes, stablePrefix, stablePrefixHash } from "./bands.ts";
export type { PromptBands } from "./bands.ts";
// §4.6 — sync: a cursor, not a sync engine.
export {
  SYNC_STATE_DDL, applyIncoming, ensureSyncState, envelopeCursor, getSyncState,
  pendingPush, syncOnce, upsertSyncState,
} from "./sync.ts";
export type { SyncEnvelope, SyncOptions, SyncResult, SyncState } from "./sync.ts";
// §5.1 — workspaces, membership, roles, hashed API tokens.
export {
  ROLES, WORKSPACE_DDL, WORKSPACE_INDEXES, addMember, authenticate, authorize,
  bearerFrom, createToken, createWorkspace, ensureWorkspaceSchema, getRole,
  listMembers, listTokens, removeMember, revokeToken, roleAtLeast,
  statusForFailure, upsertUser,
} from "./workspace.ts";
export type {
  AuthContext, AuthFailure, AuthResult, IssuedToken, Role, WorkspaceUser,
} from "./workspace.ts";
export type { CodeIndexBenchOptions, CodeIndexBenchReport } from "./code-index-bench.ts";
export { foldConstitution } from "./fold.ts";
export type { FoldConstitutionOptions, FoldedConstitution, FoldedSection } from "./fold.ts";
export { search } from "./search.ts";
export type { SearchHit, SearchOptions } from "./search.ts";
export { buildRiskIndex, formatRiskWarnings } from "./risk.ts";
export type { RiskIndex, RiskIndexOptions, RiskWarning } from "./risk.ts";
export {
  exportEventsToJsonl,
  importEventsFromJsonl,
  projectAgentsMd,
  projectConstitutionMd,
} from "./export.ts";
export type { ExportOptions } from "./export.ts";
export { runBench } from "./bench.ts";
export type { BenchOptions, BenchReport } from "./bench.ts";
export { redact } from "./redact.ts";
export type { RedactResult } from "./redact.ts";
export { isUlid, ulid, ulidTime } from "./ulid.ts";
export {
  KNOWLEDGE_EDGES_DDL,
  KNOWLEDGE_EDGES_INDEXES,
  KNOWLEDGE_EVENTS_DDL,
  KNOWLEDGE_EVENTS_FTS,
  KNOWLEDGE_EVENTS_FTS_TRIGGERS,
  KNOWLEDGE_EVENTS_INDEXES,
} from "./schema.ts";
export { BODY_CHAR_CAP, CONTRACT_BODY_CHAR_CAP, bodyCapFor, isContractBody } from "./types.ts";
export type {
  Confidence,
  EventType,
  KnowledgeEvent,
  NewKnowledgeEvent,
  Scope,
} from "./types.ts";
