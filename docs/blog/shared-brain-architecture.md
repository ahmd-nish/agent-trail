# Your team's agents should share a brain — here's the architecture

Every knowledge product in software history dies on the same rock: **nobody writes the docs.** Byterover, BuildBetter CLI, projectmem, Cursor rules, AGENTS.md — every one of them requires a human to stop doing work and author a memory. Every one of them has fewer active memories than users. Every one of them is stuck at zero-network-effect because the network effect only kicks in *after* the docs get written, and the docs never get written.

agent-trail is structurally different. Its execution loop *already* generates exactly the five event types a team-knowledge layer needs, as a byproduct of running:

| Knowledge event | Where it comes from |
|---|---|
| **decision** — a human ruling | Answered decision tickets from the `ask_human` MCP loop |
| **failed_attempt** — an approach that didn't work | Every `verify_tests` failure writes an iteration memory summary |
| **gotcha** — a fragile file or pattern | Thrash detection: same normalized error twice, on the same task |
| **steer** — mid-run guidance | The steering queue: any human can nudge a running agent |
| **artifact_summary** — what got shipped | Post-execution git diff + heuristic memory on every green task |

Nobody types anything. The human answers a question they were going to answer anyway; the agent fails a test it was going to fail anyway; both become durable, attributed, retrievable team knowledge.

The rest of this post is the architecture that makes that observation load-bearing.

---

## The substrate — one typed, append-only log

Every projection in the system — the constitution the agent reads at spawn, the risk index the governance gate consults, the module briefs, the AGENTS.md file — is a deterministic fold over one table:

```sql
CREATE TABLE knowledge_events (
  id            TEXT PRIMARY KEY,          -- ULID: time-sortable, unique across machines
  workspace_id  TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  actor_kind    TEXT NOT NULL,             -- 'human' | 'agent'
  actor_id      TEXT NOT NULL,
  actor_name    TEXT NOT NULL,
  task_id       TEXT,
  execution_id  TEXT,
  type          TEXT NOT NULL,             -- 8 canonical types
  scope         TEXT NOT NULL,             -- org | project | module:<path> | task:<id>
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,             -- capped ~1200 chars, secrets redacted
  paths         TEXT NOT NULL DEFAULT '[]',
  confidence    TEXT NOT NULL,             -- ruling (human) | observed (test) | inferred (LLM)
  valid_from    TEXT NOT NULL,
  supersedes    TEXT REFERENCES knowledge_events(id),
  superseded_by TEXT REFERENCES knowledge_events(id),
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
```

Four properties, each load-bearing:

1. **Append-only.** Corrections are new events with `supersedes` set. Never UPDATE. Never DELETE.
2. **Therefore it is a grow-only set — a CRDT for free.** Two machines that have seen the same set of IDs are in the same state, regardless of arrival order. This is why the sync protocol is a *cursor*, not a CRDT framework. Do not adopt Yjs, Automerge, or Loro for this.
3. **Temporal validity.** "Use Postgres" is not deleted when the team switches to SQLite. It's closed, with an audit trail of who changed their mind and when. This fixes the failure mode where `decisions.md` accumulates contradictions and the agent picks one at random.
4. **Provenance tiers.** A human ruling outranks an LLM inference in retrieval scoring. The score function is literally `bm25 × confidence_weight × …` — `ruling: 1.0`, `observed: 0.8`, `inferred: 0.5`. Fixes the "all notes are equal" problem every markdown-based system inherits.

## Three kinds of context — three different mechanisms

The failure mode of every previous attempt is one bucket labelled "memory" that serves all three badly. There are three:

| Kind | Change rate | Mechanism |
|---|---|---|
| **Standing practice** — coding style, PR process, "how we add a feature" | Weeks | Stable cached prefix. Written once, read at 0.10× forever. |
| **Task handoff** — "task A built the auth module, here is its public surface" | Per task | Capability contract. Downstream agent skips discovery entirely. |
| **Ambient repo shape** — what exists where, who owns it | Per commit | Symbol index + pull-tools. Precompute the map, retrieve top-K, expose MCP tools for the rest. |

The counterintuitive rule for the first bucket: **stop optimizing what to send and start optimizing what stays byte-identical.** A cached superset beats an uncached subset by 3× on the arithmetic. Send everything, always, in the same byte order, and let the cache do the work. Selection logic is actively harmful — every conditional fragments the cache. This inverts the usual context-engineering advice, and it only holds for the stable bands.

## The retrieval pipeline

Replace "concatenate every markdown file up to 8K chars, sorted alphabetically" (the current failure mode of every markdown-based tool) with:

```
1. SEED     BM25 top-50 ∪ vector kNN top-50, fused via RRF → top-10 seeds
2. EXPAND   1-2 hop code-graph traversal from seeds
3. SCORE    seed_score × edge_kind × distance_decay × confidence × recency × path_overlap
4. CUT      hard budget, highest score first
5. EMIT     signatures + paths + facts. Not file contents. Not LLM summaries.
```

Rule 5 is where most systems go wrong. **Never LLM-summarize what tree-sitter can extract exactly.** A function signature is 20 tokens, deterministic, and prevents a re-read. A prose summary is lossy in exactly the dimension (precise param names and types) that would force the agent to open the file anyway.

## The graph — yes to the graph, no to the graph database

Code is natively a graph. A 38k-LOC repo yields ~5-10k symbols and ~20-30k edges. That's a small dataset — two Postgres tables + `WITH RECURSIVE` traverses in milliseconds. Adopting Neo4j costs a second datastore, a second sync path, loss of pgvector co-location, and ops burden.

Two graphs, joined by one edge type:

- **Code graph** (`source='derived'`) — tree-sitter over source. Rebuild in seconds. On loss: no data lost.
- **Knowledge graph** (`source='asserted'`) — the event log. On loss: unrecoverable.

The bridge is `governs`. A convention like "we use conventional commits" isn't usefully graph-shaped on its own — it's a flat assertion. It becomes graph-shaped the moment it's scoped: *this* convention `governs` `packages/server/**`. And it enables the query no vector search can answer:

> file → the contract that created it → the decision that shaped it → **the teammate who made the call**

That provenance chain is the multiplayer differentiator expressed as a database query.

## The governance gate

projectmem shipped Memory-as-Governance for a single user: memory that doesn't just answer the agent but **gates its next action**. This is the team version.

```ts
precheck(paths: string[], plan?: string) → Warning[]
```

Deterministic. No model call. No embeddings. Just an index over the existing failed_attempt / gotcha events, scoped by file path. The output:

> Sarah's agent tried a null-guard in `packages/core/auth/session.ts` 3 days ago;
> verify_tests failed with the same assertion. Different approach recommended.

This generalizes `thrash detection` and `iteration_memories` — both of which are already in the loop — **across people and across time**. The paper (§5.3 of `docs/knowledgelayer.md`) is explicit that the category has no benchmark for this. Ours ships now.

## The three-band prompt — where the token savings actually come from

```
┌─ BAND A — org prefix ────────────── changes ~weekly ─── CACHE BREAKPOINT (1h TTL)
│  tool defs · system instructions · org-scope rulings
├─ BAND B — project prefix ────────── changes ~daily ──── CACHE BREAKPOINT (1h TTL)
│  project constitution (active rulings) · PROJECT_MAP · module brief
├─ BAND C — task pack ─────────────── per spawn ──────── NOT CACHED
│  task self · retrieved facts · dep memories · iteration history · steers
└─ BAND D — governance ────────────── per spawn ──────── NOT CACHED
   precheck warnings for the files this task will touch
```

Bands A + B are **byte-identical across every task in a board run and across every teammate on the same project.** A board run is dozens of spawns. At Anthropic's 0.10× discount for cached reads after a 1.25× write, that's a 5–10× reduction on the cached portion of input.

The team makes it cheaper, not more expensive. More teammates on the same project = more reads against the same cached prefix = lower per-run cost. That is a real, defensible network effect inside a 5-person team, and it is the *opposite* of how every seat-based tool behaves.

Caveat before you quote this: Anthropic caches are isolated per organization and, since Feb 2026, per workspace. Cross-teammate cache sharing requires a shared org API key, not per-user `claude login` subscriptions. Confirm empirically before it goes in copy.

## What's not built yet, and why

Full plan is in `docs/knowledgelayer.md` §6. Highlights of what's deferred:

- **The relay.** Postgres + cursor sync + GitHub OAuth. Until it ships, "multiplayer" means sharing the SQLite via git-tracked storage. Real cross-machine sync is the next big chunk of work.
- **Embeddings + vector kNN.** nomic-embed-text 256d Matryoshka. The BM25 half of hybrid retrieval is in; vectors + RRF fusion is the meaningful next slice.
- **Capability contracts (§4.2b).** tree-sitter extraction of exports/routes/tables/env from the diff, plus a Haiku pass for intent. This is the highest-value single artifact in the system and it's the honest deferral we'll close first.
- **Code graph traversal.** The graph tables + recursive-CTE traversal.

Everything above ships today, tested, in the `packages/core/src/knowledge/` module. Read `docs/knowledgelayer.md` if you want the argument for why each of these deferrals is safe.

---

If you're on a team already running Claude Code together and any of this sounds like it would remove pain you have: `bunx @agent-trail/cli --demo`, or reach out on the repo. Design-partner slots are what unblocks Weeks 9-10's multi-actor benchmark.
