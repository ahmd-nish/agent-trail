# agent-trail — Knowledge Layer v2: Consume the Code Graph, Build the Join

**Date:** 2026-08-08 · **Owner:** Nish · **Status:** proposed

**Amends** [`knowledgelayer.md`](./knowledgelayer.md) — it does not replace it. §4.1, §4.2, §4.2b, §4.3, §4.4, §4.5, §4.6, §5 and §7 stand as written. This document rewrites §4.2c and §4.2d, unblocks §4.2e, and adds one new section (§J, the join) that the original plan gestured at but never specified.

**Audited against** `ed8d17f`, and against a market survey run 2026-08-08.

---

## 0. The one thing that changed

The original plan assumed agent-trail would build its own symbol index (§4.2c) and code graph (§4.2d) with tree-sitter. Between January and June 2026 that became a commodity:

| Tool | Scale | Store | License | Relevance |
|---|---|---|---|---|
| Graphify | ~63k→100k stars, YC-backed | no vector DB | OSS + enterprise | 10 MCP tools, 17 assistants, shared HTTP graph server for teams |
| CodeGraph | 47.4k stars | embedded SQLite + FTS5 | MIT | tree-sitter, 21 langs, file-watcher incremental sync |
| GitNexus | 42k stars | LadybugDB | PolyForm **NC** | 16 MCP tools, cross-repo groups |
| codebase-memory-mcp | — | SQLite | OSS | 158 langs, hybrid LSP, single static C binary |
| Serena | 25.2k stars | live LSP | MIT | symbol-level retrieval *and* editing |

Independently measured savings in the category: 97% fewer input tokens (grepai), 70% median tool-call reduction (CodeGraph), 88% fewer tool calls (GitNexus production audit), 10× fewer tokens across 31 repos (codebase-memory, arXiv 2603.27277). Vendor-reported figures run as high as 79× — the spread means the metric definitions are not comparable, so only the independent numbers should inform planning.

Two consequences:

1. **Building §4.2c/§4.2d is now building a commodity in the most crowded tier of the category.** Four tools sit between 25k and 100k stars, one is YC-backed with an enterprise shared-graph tier, and all of them do it better than a from-scratch implementation would in its first six months.
2. **None of them touch the other half.** Every tool above derives its graph from *source code*. §4.2e already enumerates what source code cannot tell you: why a decision was made, the three approaches that failed and were never committed, who ruled on it, and when that ruling stopped being true. That is agent-trail's five capture sources, and it remains unbuilt by anyone.

So: **consume the derived half, build the asserted half, own the join between them.**

The original §4.2d Decision 2 — "two graphs, joined, not one graph" — was correct and is now load-bearing. This document is mostly the consequence of taking it seriously.

### The graph-database question, settled

Do not adopt one. Kuzu, the obvious embedded pick, was acquired by Apple in October 2025 and the repo archived; LadybugDB is a community fork. The two category leaders store their graphs in embedded SQLite, and Graphify ships with no vector database at all. §4.2d's "Postgres, not Neo4j" call holds; the 2026 refinement is that SQLite is sufficient for the local mirror and Postgres is only needed at the relay.

### The Obsidian question, settled

Not as a store — it offers no retrieval scoring, no temporal validity, no attribution, and no multi-writer merge, which are the four properties §4.1 exists to provide. As an *export projection* it is worth one afternoon: MCPVault and mcp-obsidian are mature, markdown needs no parsing layer, and `projectConstitutionMd` / `projectAgentsMd` already exist. Add `projectObsidianVault()` alongside them in Phase 4. It is a fold, not an architecture.

---

## 1. Scope

**Consume (do not build):** symbol extraction, call/import/definition edges, blast-radius traversal, incremental re-index on file change, multi-language parsing.

**Build (nobody has it):** the append-only knowledge event log with temporal validity and provenance; `governs` edges joining knowledge to symbols; contract validity derived from git; retrieval that scores across both graphs; and multi-user sync of the asserted half.

**Delete from the plan:** §4.2c `symbols` table, §4.2d `graph_nodes` / `graph_edges` for derived code structure, the tree-sitter dependency, and `repo-map.ts`'s term-overlap ranker (superseded, not replaced).

### What this unblocks

The tree-sitter dependency was silently blocking §4.2e. `signature_hash` requires re-parsing changed files to re-extract the signature set; the current regex extractor is self-consistent but under-triggers, so signatures it never captured cannot change the hash — a stale contract reads as verified-current. Sourcing signatures from an external index removes that failure mode without agent-trail owning a parser.

---

## 2. Phase 0 — prove the loop runs at all (½ day)

**This is the gate for everything below.** `knowledge_events` currently has **0 rows** in `agent-trail.db`, and `iteration_memories` has 0. The read and write sides landed in `d4bcbb5`, after the 38 executions in the database. The thesis is demonstrably real in 72 tests and has never produced a single row from a real run.

- [x] Run one real board task end-to-end. Assert `SELECT COUNT(*) FROM knowledge_events > 0`.
- [x] Confirm a second task's pack contains at least one event from the first.
- [x] Resolve `BODY_CHAR_CAP`. `store.test.ts:68` is titled *"clamps body to the 1200-char cap"* and encodes §4.1's spec; the code is 4000. This is a spec decision, not a stale assertion — 4000 chars is ~1,000 tokens per event, and a pack holding several of them materially changes the Band C budget. Pick a number deliberately and update both sides.
- [x] Split `cache_read_input_tokens` out of `totalInputTokens` in `telemetry/parser.ts:115`. One line. Without it cache-hit rate can never be measured, and §4.4 has no feedback signal.

**Exit criteria:** a real run produces events, a later run consumes them, and the test suite is green.

> **DONE 2026-08-08.** Exit criteria met, and the gate justified itself: running the
> loop for real found a bug that 72 unit tests could not see.
>
> - **The loop runs.** A real board task emitted `failed_attempt` + `gotcha` events;
>   a second task's pack carried the first task's failure via §4.3 retrieval *and* a
>   §4.5 governance warning naming the shared file.
> - **`paths` was always `[]` on every emitted event.** `execution-manager.ts` read
>   `task.likely_paths` (the column name) off a `rowToTask()` object, whose field is
>   `likelyPaths`. So the §4.5 governance gate could never match a file, and §J's edge
>   auto-population — which keys entirely off `event.paths` — would have been
>   stillborn. Fixed, and pinned by a new `knowledge-loop-e2e.test.ts` that was
>   verified to fail on the old code.
> - **`BODY_CHAR_CAP` resolved as a type-aware cap**, not one number. Prose stays at
>   §4.1's 1200; only an `artifact_summary` whose body parses as a capability contract
>   earns 4000. Reasoning: prose is read *in addition to* the code, a contract is read
>   *instead of* it, so only the contract's bytes buy back tool calls. A flat 4000 let
>   a few prose events eat the Band C budget this layer exists to protect.
> - **Cache tokens split and persisted** (migration v25). `total_input_tokens` keeps
>   its meaning — four consumers and 38 rows of history depend on it — and the
>   breakdown lands in two new columns. `bench` now reports `cacheHitRate`, `null`
>   rather than `0` when unmeasured, so a working cache never reads as broken.
> - **Noted, not fixed:** `pricing.ts:25` bills cached reads at full input rate, so the
>   cost dashboard overstates cost on any cache-heavy run. Now measurable; fix belongs
>   with §4.4.

*Aside, tracked separately: the four launch-debt items are scripted and unrun, all four npm names still 404, and v1.0.0 was tagged 2026-07-05. That is ~2 hours behind an auth prompt and it is risk #1 in §7 of the original plan. It does not block this document, and this document should not be used as a reason to keep deferring it.*

---

## 3. Phase 1 — the code-index adapter, and the measurement gate (3–4 days)

You chose to prototype both and decide on evidence. This phase is that spike, structured so it produces a decision rather than an impression.

### 3.1 The adapter interface

Depend on a narrow interface, never on a vendor. `packages/core/src/knowledge/code-index.ts`:

```ts
export type SymbolKind =
  | "function" | "class" | "method" | "type"
  | "route" | "table" | "env" | "file";

export interface SymbolRef {
  path: string;              // repo-relative, POSIX separators, always
  name: string;
  kind: SymbolKind;
  line?: number;
  signature?: string;        // exact text; never an LLM summary (§4.2d rule 2)
}

export interface CodeIndex {
  readonly name: string;                     // 'codegraph' | 'serena' | 'native'
  available(): Promise<boolean>;
  symbolsInPaths(paths: string[]): Promise<SymbolRef[]>;
  findSymbol(name: string): Promise<SymbolRef[]>;
  getSignature(ref: Pick<SymbolRef, "path" | "name">): Promise<string | null>;
  whoCalls(ref: Pick<SymbolRef, "path" | "name">, depth?: number): Promise<SymbolRef[]>;
  indexedAtSha(): Promise<string | null>;    // for staleness (§5)
}
```

Four rules, each load-bearing:

1. **Stable, vendor-neutral addressing.** A symbol is always `sym:<repo-relative-path>#<name>`; a file is `file:<path>`. Never persist a backend's internal node ID — those change on re-index and are meaningless on a teammate's machine, which would make `governs` edges unsyncable.
2. **A `native` implementation is mandatory.** It wraps the existing regex extractor in `contracts.ts` plus `repo-map.ts`. Correctness must never depend on an external MCP server being installed — same principle as §4.2e's `post-merge` hook being an optimization rather than a requirement.
3. **Every method is allowed to return empty.** Degradation is silent and expected; the pack simply carries less.
4. **Never send file contents through this interface.** Signatures and paths only.

### 3.2 What to build in the spike

- [x] `native` adapter — wraps what exists today. This is the control.
- [ ] `codegraph` adapter — MIT, embedded SQLite, closest to the shape §4.2c specified. Read its SQLite file directly if the schema is stable; fall back to MCP tool calls if not.
- [ ] `serena` adapter — LSP-backed, different failure mode (live and always-current, but requires a language server per language). Worth measuring because its staleness profile is the opposite of an indexed tool's.

> Neither external backend is installed on this machine (`codegraph`, `serena` both
> absent; `uvx` is present so both are installable). Installing third-party software is
> a supply-chain decision, so it is left for an explicit call rather than done silently.
> The interface and the bench are backend-agnostic — scoring either one is a
> `resolveCodeIndex` registry entry plus one bench run, no rework.

Skip GitNexus in the spike: PolyForm Noncommercial is incompatible with agent-trail's MIT distribution and the Team Cloud tier in §5.1. Note it and move on.

### 3.3 The measurement

Run against two corpora, because one of them will lie to you:

- **agent-trail itself** (~38k LOC) — the familiar-repo case.
- **One unfamiliar mid-size OSS repo** (10k+ files) that neither you nor the planner has seen.

**The unfamiliar repo is not optional.** Live telemetry across 38 executions on agent-trail shows Bash 278, Read 232, Write 35, Glob 20, Edit 18, **Grep 1**. Discovery is already near-zero here because the planner emits `likelyPaths` and the runner uses them — you solved discovery in Phase 1–5 without a knowledge layer. Measuring "discovery → zero" on this repo will show almost no headroom and produce a number that understates the value on any repo a new teammate actually joins.

Metrics per adapter per corpus:

| Metric | Why it decides something |
|---|---|
| Symbol coverage of `likelyPaths` | If an adapter can't resolve the paths tasks actually touch, `governs` edges will be sparse and the join is worthless |
| p50 / p99 resolution latency | This sits on the critical path of every spawn |
| Index build time + on-disk size | Determines whether a teammate can onboard in minutes |
| Staleness false-negative rate | Edit a signature, ask whether the adapter notices. `native` will score badly here; that is the point |
| Discovery tool calls, with vs without | The headline number, and only meaningful on the unfamiliar repo |
| Setup steps for a second developer | The multiplayer cost nobody benchmarks |

### 3.4 Decision criteria — write these down before running

Adopt an external index as the **default** if, on the unfamiliar repo, it delivers **≥50% symbol coverage of `likelyPaths`**, **p99 resolution under 200ms**, and **a staleness false-negative rate below the `native` adapter's**. Otherwise ship `native` as default and keep the external adapters as opt-in.

Either way the adapter interface ships, because it is what §J joins against.

**Exit criteria:** a written decision, a table of numbers behind it, and one adapter marked default in config.

> **DECISION 2026-08-08 — ship `native` as default. Do not adopt an external index yet.**
>
> Measured with `runCodeIndexBench`, corpus = agent-trail's own 239 tracked TS/JS files
> (the last 40 commits touched all of them, so the "changed files" proxy is the whole
> codebase here). `tasks.likely_paths` was empty on all 44 rows — a consequence of the
> Phase 0 bug — so the commit footprint is the only honest corpus available today.
>
> | Metric | `native` | Gate | Verdict |
> |---|---|---|---|
> | Coverage, files declaring ≥1 export | **96.6%** (141/146) | ≥ 50% | clears by 46 pts |
> | Coverage, all corpus files | 59.0% (141/239) | — | 84 test files export nothing |
> | Resolution latency p50 / p99 | **0.11ms / 1.08ms** | p99 < 200ms | clears by 185× |
> | Whole-repo scan | **10.75ms**, 239 files → 489 symbols | onboarding | negligible |
> | Blind-spot rate (staleness FN proxy) | **6.5%** (34/523 exports) | < native | n/a — this *is* native |
>
> **Why this settles it for now.** §3.4's gate was written to justify *adopting* an
> external index. On a TS repo the control already clears both thresholds with room to
> spare, so there is no coverage or latency headroom left for an external backend to buy.
> Adopting one would add a solo-maintained dependency (§11 risk 1) and a per-teammate
> install step to win a fraction of 6.5%.
>
> **The one real deficit, and the cheap fix.** The blind spots are not spread evenly —
> they are concentrated in three shapes the regex structurally cannot see:
>
> ```
> export { a, b } from "./x"   13/13 missed
> export * from "./x"           4/4  missed
> export default                3/3  missed
> ```
>
> That is 20 of the 34 misses, and it is exactly the §4.2e failure mode: a signature
> change behind a re-export cannot move `signature_hash`, so a stale contract reads as
> verified-current. Extending the native extractor to these three shapes is bounded
> work with no new dependency, and would cut the blind-spot rate to roughly 2.7%.
> Do that before reconsidering an external backend.
>
> **What this does NOT establish.** §3.3's unfamiliar-repo requirement is unmet — this
> is the familiar corpus, and the doc is explicit that it understates the value of an
> external index on a repo nobody has seen. The discovery-tool-call delta was
> deliberately not measured here for the same reason (Grep 1 / Glob 20 across 38
> executions leaves no headroom to recover). Treat this decision as *provisional and
> corpus-bound*: it says native is sufficient for repos shaped like agent-trail, not
> that external indexes are unnecessary in general.
>
> Shipped: `code-index.ts` (interface, URN addressing, `NativeCodeIndex`,
> `resolveCodeIndex` with fallback-on-failure), `code-index-bench.ts` (backend-agnostic
> scoring), 26 tests. `AGENT_TRAIL_CODE_INDEX` selects a backend; unknown or unhealthy
> names warn and fall back to native rather than failing a spawn.

---

## 4. Phase 2 — §J, the join (4–5 days)

This is the only genuinely novel graph work left, and the answer to *"if we don't know the depth of where these things are connected, we may fail a lot."*

### 4.1 Schema

Edges are **asserted**, not derived — they are claims about which knowledge applies where. So they live in agent-trail's log, are append-only, and sync exactly like events do.

```sql
CREATE TABLE IF NOT EXISTS knowledge_edges (
  id           TEXT PRIMARY KEY,        -- ULID
  workspace_id TEXT NOT NULL DEFAULT 'local',
  project_id   TEXT NOT NULL DEFAULT 'local',
  src          TEXT NOT NULL,           -- 'kev:<event-ulid>'
  dst          TEXT NOT NULL,           -- 'sym:<path>#<name>' | 'file:<path>' | 'module:<dir>'
  kind         TEXT NOT NULL,           -- governs | produced_by | decided_in | invalidated_by
  weight       REAL NOT NULL DEFAULT 1.0,
  resolver     TEXT NOT NULL,           -- adapter name, or 'paths' when taken from event.paths
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kedge_dst  ON knowledge_edges(dst, kind);
CREATE INDEX IF NOT EXISTS idx_kedge_src  ON knowledge_edges(src, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kedge_hash
  ON knowledge_edges(workspace_id, project_id, content_hash);
```

`resolver` matters: an edge resolved by `native` regex is weaker evidence than one resolved by a type-aware index, and retrieval scoring should reflect that.

### 4.2 Auto-population — the part you asked for

On every `append()`, in the same transaction:

1. Take `event.paths`.
2. Emit a `file:` edge per path immediately — free, always works, never blocks.
3. Asynchronously resolve `symbolsInPaths(event.paths)` through the active adapter and emit `sym:` edges. Best-effort; failure is a no-op.
4. For `artifact_summary` events carrying a capability contract, additionally emit `produced_by` edges from the contract's `exports` / `routes` / `tables`.

Nobody types anything, and the graph is current within one task of the work that changed it.

### 4.3 The three queries that justify the whole design

**Q1 — What governs what I'm about to touch.** The pack-time query, one indexed join, no model call, no embeddings:

```sql
SELECT e.* FROM knowledge_events e
JOIN knowledge_edges g ON g.src = 'kev:' || e.id
WHERE g.dst IN (/* file: and sym: URNs for task.likelyPaths */)
  AND e.superseded_by IS NULL
ORDER BY e.valid_from DESC;
```

**Q2 — Blast radius, joined.** `task.likelyPaths` → `whoCalls()` 1–2 hops through the *external* index → the paths those callers live in → Q1 over that expanded set. This is the query no single tool in the market answers: the code graph supplies structural reach, the knowledge graph supplies the rulings and prior failures that apply to it.

**Q3 — Provenance chain.** `file → contract that created it → decision that shaped it → the teammate who made the call.` §4.2d called this the multiplayer differentiator expressed as a query; with `produced_by` and `decided_in` edges it becomes three joins.

Apply §4.2d Decision 3 without exception: **traverse to rank, then let a hard budget cut.** Two hops from ten seeds reaches hundreds of nodes; sending them all rebuilds the context bloat this exists to kill. Emit signatures and paths, never summaries, never file contents.

**Exit criteria:** Q1 and Q2 run in the packer, a test proves a second task inherits a first task's ruling via a `sym:` edge rather than a path string match, and p99 stays under 200ms.

> **DONE 2026-08-08.** All three exit criteria met. Migration v26, `edges.ts`, 20 tests.
>
> **One design correction, caught by the tests.** The first cut emitted `governs` edges to
> the file *and every ancestor module* on write. That is wrong: it makes a fact about
> `src/api.ts` claim to govern every sibling under `src/`, and it showed up immediately as
> two unrelated files matching each other. The expansion belongs on the **read** side only:
>
> - `leafUrn(path)` — WRITE. One edge: `file:` for a file, `module:` for a directory.
> - `pathUrns(path)` — READ. The path plus every ancestor module.
>
> The asymmetry is the point. Expanding on write makes a fact about one file over-claim
> across its directory; expanding on read makes a directory-scoped ruling reach the files
> inside it. Only the second is true.
>
> **Latency, measured at 5,000 events / 5,971 edges / 202 files:**
>
> | Query | p50 | p99 | Gate |
> |---|---|---|---|
> | Q1 `knowledgeGoverning` | 2.76ms | **4.32ms** | <200ms ✓ |
> | Q2 `blastRadius` | 15.13ms | **139.74ms** | <200ms ✓ |
>
> Q2 initially measured **200.52ms p99 — a fail**. Cause: `whoCalls` re-read every file in
> the repo once *per symbol*, so a module with 20 exports triggered 20 full scans. Fixed
> with an mtime-keyed content cache in `NativeCodeIndex` plus a `maxSymbolsExpanded` cap
> (default 25) on traversal breadth — §4.2d Decision 3, and the cap logs what it dropped
> rather than letting a bounded answer read as exhaustive.
>
> Note the headroom is thin *because* the control's `whoCalls` is a full-repo text scan
> with no index. This is the one place where an external backend has a concrete argument,
> and it is worth re-measuring §3.4 against if Q2 ever moves onto a hot path.
>
> **Live in the packer** — a real spawn now assembles:
> `L0 constitution · L1 pack · upstream handoffs · related knowledge · **Knowledge graph (§J)** · governance warnings`.

---

## 5. Phase 3 — the validity oracle, now unblocked (2 days)

§4.2e as originally written, with the adapter supplying signatures instead of a tree-sitter pass agent-trail owns.

- [ ] Persist `base_sha` on every contract at emit time. The field already exists (`contracts.ts:24,80`) and is populated; nothing computes against it yet.
- [ ] Compute `signature_hash = sha256(sorted(exports ∪ routes ∪ tables ∪ env))` from the adapter's output, not from the regex extractor, and store it beside `base_sha`.
- [ ] At pack time: re-resolve signatures for `contract.paths` through the adapter, recompute the hash, compare. Equal → still valid despite file edits. Different → drifted, and you know exactly which symbols moved.
- [ ] Re-derive structure automatically on drift (free — it is one more adapter call). Leave `invariants` / `deliberatelyNotDone` empty rather than guessing; they are currently hardcoded `[]` at `contracts.ts:89-90` and a wrong invariant is worse than a missing one.
- [ ] `post-merge` hook that precomputes the answer. **Optimization only.** Correctness stays pull-based, so a fresh clone or an uninstalled hook still yields the right result.
- [ ] Commit trailers (`Agent-Trail-Contract: <id>`), not `git notes` — trailers survive rebase and cherry-pick and push by default.

One correction to the original §4.3 scoring formula: it contains `× 0 if superseded_by IS NOT NULL OR contract.stale`. Until this phase lands, `contract.stale` is unimplementable, so retrieval is structurally incapable of excluding a stale contract. That term becomes real here.

**Exit criteria:** edit a signature outside agent-trail, and the next pack marks the contract drifted and ships re-derived signatures.

---

## 6. Phase 4 — retrieval and projections over the joined graph (3 days)

- [ ] Extend `search()` to seed from two sources: FTS5/BM25 over `knowledge_events` (exists), **union** the Q1 reverse lookup from `task.likelyPaths`. Structural seeding is what makes the graph pay; similarity alone cannot answer *"I'm changing `createSession`, what breaks?"*
- [ ] Score with the §4.3 formula, adding one term: `resolver_weight` (typed index 1.0 / `native` regex 0.6), because a regex-resolved edge is weaker evidence.
- [ ] Cut to the pack budget. Emit signatures, paths, and facts.
- [ ] `projectModuleBriefs()` and `projectProjectMap()` — the two §4.2 projections still ❌. These belong in Band B where they are written once and read at 0.10×, not regenerated per query.
- [ ] `projectObsidianVault()` — one fold beside `projectConstitutionMd` / `projectAgentsMd`. Emits one note per active event with frontmatter and `[[wikilinks]]` along `governs` edges, so the graph is browsable by humans in Obsidian and readable by any MCP-connected agent. Export target, not a store.

**Defer:** embeddings, vector kNN, and RRF fusion. The category's evidence in §0 is that structure beats similarity for code, Graphify ships with no vector DB at all, and BM25 + structural seeding covers the cases you have. Revisit only when §7 measurement shows a gap.

**Exit criteria:** a task whose `likelyPaths` overlap a governed module gets the ruling in its pack without the ruling's text matching the task description.

---

## 7. Phase 5 — sharing, which is still the actual gap (1.5–2 weeks)

Everything above works on one machine and none of it is what you're selling.

The buy/build split makes this dramatically simpler, and this is the strongest argument for it:

| | Code graph (derived) | Knowledge + edges (asserted) |
|---|---|---|
| Origin | external index, per machine | agent-trail's execution loop |
| On loss | rebuild in minutes | **unrecoverable** |
| Size | 100s of MB | ~1KB/event; 10k events ≈ 10MB |
| Sync | **never — each machine builds its own** | append-only log + cursor |

So the sync surface is the small, precious half. Nobody ships a GB index over the wire; each teammate's adapter builds locally, and agent-trail syncs kilobytes of decisions on top. That is a clean answer to *"shareable between multiple users and multiple agents on the same project."*

- [ ] `POST /v1/events` — append, dedupe on `content_hash`. Carries `knowledge_edges` in the same envelope.
- [ ] `GET /v1/events?since=<ulid>` — tail, returns next cursor.
- [ ] `GET /v1/events/stream?since=<ulid>` — SSE live tail.
- [ ] Local outbox on the SQLite mirror; on reconnect push unsent, pull from cursor. Append-only ⇒ no conflict resolution.
- [ ] Workspace model + better-auth GitHub OAuth; replace `workspace_id` hardcoded to `'local'`.
- [ ] `sync: local-only` per project, before anyone is charged (§5.2).

Still explicitly **not** adopting ElectricSQL / PowerSync / Zero / LiveStore or any CRDT library. An append-only log needs a cursor, not a sync engine (§4.1 property 2).

**Timing note.** The multi-user gap is closing from the code side: Graphify shipped a Streamable HTTP transport so one shared graph server serves a whole team, and GitNexus added an enterprise track. Shared *code* graphs are being solved right now. Shared, attributed, temporally-valid *decision* knowledge is not — and that window is not indefinite.

**Exit criteria:** two machines, one workspace. Answer a decision ticket on A; B's next spawn inherits it with no git push.

---

## 8. Measurement

Replace the headline metric. §5.3 named discovery tool calls, and on agent-trail's own telemetry that number has nowhere to fall (Glob 20, Grep 1 across 38 executions). Keep it, but measure it on the unfamiliar repo only.

The metric to own, because no tool in §0 reports it:

> **Cross-actor governance rate** — the fraction of task packs containing ≥1 knowledge event that was (a) authored by a different actor and (b) joined by a `governs` edge to a file the task actually modified.

Both clauses matter. (a) alone is the existing `contextReuseRate`, which is vanity — it counts facts that were present, not facts that were relevant. (b) makes it a claim about usefulness. It is measurable from data you already persist, and it is the number that distinguishes a shared brain from a shared folder.

Supporting metrics, all already scaffolded in `bench.ts`: tokens/task, cache hit rate (needs Phase 0's parser split), repeat-failure prevention rate, time-to-first-green, $/merged PR.

Note the competitive bar has moved: this category now publishes numbers. A benchmark that only reports token savings enters a crowded field with figures from 35% to 79×. One that reports cross-actor governance rate is uncontested.

---

## 9. What this deletes

| Was | Now |
|---|---|
| §4.2c `symbols` table + `find_symbol` / `get_signature` / `who_calls` | Adapter methods over an external index |
| §4.2d `graph_nodes` / `graph_edges` for code structure | External index owns it; `knowledge_edges` holds only asserted edges |
| tree-sitter / `web-tree-sitter` dependency | None — adapter supplies signatures |
| `repo-map.ts` term-overlap ranker | Superseded by `symbolsInPaths` + Q1 |
| §4.3 embeddings / kNN / RRF | Deferred until measurement demands it |
| Weeks 1–2 "symbol index + code graph" line items | Phases 1–2 above |

Net: roughly three weeks of the original plan removed, replaced by ~1.5 weeks of adapter and join work that no competitor has.

---

## 10. Sequencing

| Phase | Work | Est. | Unlocks |
|---|---|---|---|
| 0 | Prove the loop runs | ½ day | Everything. Currently 0 events from real runs |
| 1 | Adapter + measurement gate | 3–4 days | An evidence-backed buy/build decision |
| 2 | §J the join | 4–5 days | Blast radius + provenance; the novel query |
| 3 | Validity oracle | 2 days | Contracts stay honest as the repo moves |
| 4 | Retrieval + projections + Obsidian | 3 days | The pack gets structurally relevant, not just similar |
| 5 | Relay + sync | 1.5–2 wks | Everything multiplayer. The product |

Roughly five weeks to the first real multiplayer moment, against three weeks of deleted work.

---

## 11. Risks specific to this plan

**1. Adapter churn.** CodeGraph is ~91% one person's commits at 47.4k stars; GitNexus, grepai, and several others are solo projects. Mitigated by the interface in §3.1 and the mandatory `native` fallback — a dead backend is a config change, not a rewrite.

**2. Licensing.** GitNexus is PolyForm Noncommercial and cannot ship inside an MIT product with a paid tier. Check every adapter's license against §5.1 before it becomes a default.

**3. IDE-native absorption.** Anthropic still ships grep-only retrieval in Claude Code; if that changes, the entire external-index tier compresses. This plan is *more* robust to that than the original, not less: agent-trail would swap adapters and keep the asserted half, which is the part first-party tools have no way to capture.

**4. The join is sparse.** If adapters resolve few symbols for real `likelyPaths`, edges degrade to `file:` granularity and Q2 loses most of its value. §3.3 measures this before you build on it, which is why coverage is a gate criterion and not an afterthought.

**5. Still not launched.** Unchanged, and still ranked first in the original §7. Five weeks of good architecture does not alter the fact that four scripted launch tasks have been outstanding since 2026-07-05 and no commits have landed since 2026-08-01. This plan is worth executing; it is not worth executing *instead*.

---

## 12. Sources

- [Code Intelligence Tools for AI Agents Compared — Ry Walker Research](https://rywalker.com/research/code-intelligence-tools)
- [CodeGraph](https://github.com/colbymchenry/codegraph) · [Graphify](https://graphify.com/) · [GitNexus](https://github.com/abhigyanpatwari/GitNexus) · [Serena](https://github.com/oraios/serena) · [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
- [Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP (arXiv 2603.27277)](https://arxiv.org/html/2603.27277v1)
- [KuzuDB abandoned after Apple acquisition — The Register](https://www.theregister.com/2025/10/14/kuzudb_abandoned/)
- [MCPVault: Obsidian as live agent memory](https://medium.com/@ai_transfer_lab/mcpvault-the-claude-skill-that-turns-obsidian-into-a-live-agent-memory-6f3aca3dfc4c)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956)
