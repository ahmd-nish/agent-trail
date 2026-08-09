# inventarium — Shared Knowledge Layer

**Date:** 2026-07-28 · **Owner:** Nish · **Mode:** full-time solo, relay-first, 1–2 dogfood partners

**Supersedes:** `30-day-plan.md`, `MASTER_PLAN.md`, `INTELLIGENCE_LAYER_PLAN.md`, `RELEASE_PLAN_V1.md`, `SHIP_PLAN_3_DAYS.md`, `PRD_OPEN_SOURCE.md`, `PRD_PAID.md`. Archive those to `docs/internal/archive/`. One live plan from here.

---

## 0. The one-sentence thesis

> **Every other team-memory product asks people to write down what they know. inventarium already watches them do the work — so the knowledge writes itself, and every teammate's agent inherits it.**

That is the whole moat. Read §2 before anything else.

---

## 1. Why now — the three signals

**Signal 1 — YC named your product category.**

YC's Fall 2026 RFS "Multiplayer AI" (by Aaron Epstein) reads like a spec for what you already half-built:

> "Anyone on a team should be able to drop into the same live agent session to watch it work, redirect it, and hand it off, the way they'd work with any other human team member. This turns the work a team does with agents into a shared, living thing instead of a thousand private threads." … "Shared agents for engineers coding together in real time."

Map that onto what exists in your repo today:

| YC's words | inventarium today | Gap |
|---|---|---|
| "drop into the same live agent session" | SSE feed per task | Single-machine only |
| "watch it work" | cinematic activity feed | ✅ done |
| "redirect it" | steering queue (`POST /api/tasks/:id/steer`) | Single-actor, no attribution |
| "hand it off" | — | Missing |
| "instead of a thousand private threads" | board + decision tickets | Local SQLite only |

You are not pivoting. You are finishing.

**Timing caveat:** Fall 2026 applications closed **July 27, 8pm PT** — yesterday. Decisions Aug 28, batch runs Oct–Dec in SF. Late applications are accepted without a guaranteed response window. Treat this RFS as free positioning language and market validation; target the next batch with 3 months of usage data and design-partner logos, which is a far stronger application than a late one with neither.

**Signal 2 — the academic state of the art lists your opening as unbuilt future work.**

*PROJECTMEM* (Malo & Qiu, arXiv 2606.12329, June 2026) is the closest published system to your context layer: local-first, event-sourced, plain-text memory for coding agents with a deterministic pre-action gate. Its stated limitations:

> "The current system is **single-user and local**."

And its future work item #5:

> "**Multi-user synchronization.** A conflict-free merge of append-only event logs — in the spirit of local-first software — would let a team share one project memory … extending the audit trail to collaborative settings."

The literature's own roadmap points at the thing YC is asking to fund. That is an unusually clean alignment, and it also hands you the design (§4) rather than making you invent it.

**Be precise about the gap, though — I checked the shipped product, not just the paper.** projectmem ships on PyPI, MIT, with docs at projectmem.dev, and its README already claims naive team sharing: it commits the *distilled* files (`summary.md`, `PROJECT_MAP.md`, `issues/`) and **gitignores the raw `events.jsonl`** so "your teammate's AI inherits your team's knowledge — just `git clone`."

That gitignore is the tell. They exclude the log precisely because concurrent appends conflict, which means teammates share a *snapshot* someone else generated, with no attribution, no conflict-free merge, no live propagation, and no way to reconstruct history. The paper's future-work item exists because the shipped workaround is lossy. So the accurate framing is not "nobody shares team memory" — it's **"nobody shares it live, attributed, mergeable, and retrievable."** That's a narrower claim and it survives contact with a skeptic.

One more data point worth absorbing: projectmem is a genuinely good, well-documented, shipped product — with **0 stars.** Building the thing is not the hard part. See §7 risk 1.

**Signal 3 — the pain is measured, not assumed.**

- Context fragmentation is repeatedly cited as the #1 reason AI coding productivity stalls on teams; reported cost is 4–7 hours per developer per week to context drift.
- A stateless agent burns an estimated **5,000–20,000 tokens per session** re-deriving project context. A memory layer's read cost is roughly *fixed* (~800–1,500 tokens) after a one-time write.
- Prompt caching gives a **90% discount on cached input reads** (Anthropic: 1.25× base rate for a 5-min cache write, 0.10× per read thereafter) — but only against a *stable prefix*. One production case raised cache hit rate 7% → 84% and cut total LLM spend 59–70%.

Those three numbers are your entire token story, and §5 turns them into architecture.

---

## 2. The moat: capture is already solved

Every knowledge product in history dies on the same rock: **nobody writes the docs.** Byterover, BuildBetter CLI, projectmem, AGENTS.md, Cursor rules — all of them require a human to stop working and author a memory, or a git hook to guess intent from a commit message.

inventarium is structurally different. Its execution loop *already* generates exactly the five event types a knowledge layer needs, as a byproduct of running:

| Knowledge event | Where it already comes from in your code |
|---|---|
| **decision** (a ruling) | `ask_human` ticket answered → `appendDecision()` in `context/store.ts` |
| **failed_attempt** | verify_tests failure → `iteration_memories` table (migration v21) |
| **thrash / fragile file** | `loop/thrash.ts` normalized-error repeat detection |
| **steer** (guidance) | `steering` table (migration v19) |
| **artifact_summary** | post-execution git diff + `buildHeuristicMemory()` |

Nobody types anything. The human answers a question they were going to answer anyway; the agent fails a test it was going to fail anyway; both become durable, attributed, retrievable team knowledge.

**Positioning line:**

> *"Byterover gives your team a shared notebook. inventarium gives your team a shared brain that fills itself — because it's watching the work."*

Say it in the README, the Show HN comment, and the YC application.

---

## 3. What's wrong with the current context layer

Read `packages/core/src/context/store.ts` and `memory.ts` with fresh eyes. Four things break the moment a second person shows up.

**3.1 The L0 constitution is a dump, not a retrieval — and it silently loses data.**

`loadConstitution()` concatenates `CLAUDE.md` + every `.inventarium/context/*.md`, **sorted alphabetically**, hard-capped at 8,000 chars. On a solo project that's fine. On a team, `decisions.md` grows every time anyone answers a ticket. The day it crosses the cap, rulings start silently dropping out of every agent's prompt — and *which* ones drop is determined by filename sort order, not relevance or recency.

This is a correctness bug at team scale, not a performance issue. It is the single most important thing to fix.

**3.2 No temporal validity — contradictions accumulate.**

`decisions.md` is append-only markdown with no supersession. Decide "use Postgres" in week 1 and "actually SQLite" in week 6, and both are in the constitution. The agent sees a contradiction and picks one at random. Zep/Graphiti solved this with validity windows (`true from X until Y`); you need the same idea, deterministically.

**3.3 Prompt assembly is anti-optimized for caching.**

`buildSystemPrompt()` puts phase instructions first, then the constitution. The L1 pack (volatile: steers, iteration history, per-task deps) is assembled per spawn. There is no stable prefix, no cache breakpoint, no measurement. A board run is *dozens* of spawns that could share one cached prefix and currently share none. This is free money on the floor.

**3.4 `state.json` last-write-wins is a data-loss surface for teams.**

`deserializeAndUpsert()` resolves conflicts with `WHERE excluded.updated_at >= tasks.updated_at`. Two teammates editing two different fields of the same task: one edit vanishes. Fine for one person, unacceptable for the product you're describing.

---

## 4. Architecture

### 4.0 Three kinds of context, three different mechanisms

This section is the design spine. Getting it wrong means building one generic "memory" bucket that serves all three badly — the failure mode of every competitor in §5.4.

| # | Kind | Examples | Change rate | Mechanism | Where the saving comes from |
|---|---|---|---|---|---|
| **1** | **Standing practice** | Coding style, PR process, env-var handling, "how we add a feature", company + domain knowledge | Weeks | **Stable cached prefix** (Band A/B) | Written once, read at 0.10× forever |
| **2** | **Task handoff** | "Task A built the auth module — here is its exact public surface" | Per task | **Capability contract** (§4.2b) | Downstream agent skips *discovery* entirely |
| **3** | **Ambient repo shape** | What exists where, who owns it, which files are fragile | Per commit | **Symbol index + MCP pull tools** | Agent reads 3 files instead of exploring 40 |

#### The counterintuitive rule for kind 1

Your instinct will be to inject practices *selectively* — "PR conventions only matter at the end, so don't send them during `write_tests`." **Resist it.** Do the arithmetic:

```
Full practice set, always sent, cached:   3,000 tok × 0.10 =   300 effective
Clever per-phase slice, uncached:         1,000 tok × 1.00 = 1,000 effective
```

A cached superset beats an uncached subset by 3×. **For standing knowledge, stop optimizing what to send and start optimizing what stays byte-identical.** Selection logic is actively harmful here — every conditional you add fragments the cache. Send everything, always, in the same byte order, and let the cache do the work.

This inverts the usual context-engineering advice, and it only holds for the stable bands. Kinds 2 and 3 are volatile by nature and must be selected.

#### The honest limit: you are killing *search*, not *reading*

You cannot get to zero code reads, and you shouldn't want to. The expensive part of a cold agent run isn't reading the 3 files it needs — it's the 30–40 tool calls spent *finding* them, all of which stay in the context window and get re-sent on every subsequent turn. That accumulation is the real burn.

Rough illustrative model for one mid-sized task (**estimates to be replaced by §5.3 measurements — do not quote these**):

| | Cold agent | With the layer |
|---|---|---|
| System + tools | 3k | 3k → **cached, ~300 eff.** |
| Practices / constitution | 0 | 3k → **cached, ~300 eff.** |
| Discovery (glob/grep/read to *find* things) | **30–60k, accumulating** | **~0** |
| Dependency contracts + retrieved facts | 0 | ~2k |
| Targeted reads (3 files it actually needs) | 8k | 8k |
| **Rough total, single turn** | **~45–70k** | **~11k** |

The win is the discovery row going to zero, and it compounds because discovery output is re-sent every turn. Target ~60–75% reduction, not 100%. If you build expecting 100% you will read a real 70% as failure.

---

### 4.1 Substrate — one typed, append-only, never-edited event log

Everything else in this document is a projection of this table.

```sql
CREATE TABLE knowledge_events (
  id            TEXT PRIMARY KEY,          -- ULID: time-sortable, collision-free across machines
  workspace_id  TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  actor_kind    TEXT NOT NULL,             -- 'human' | 'agent'
  actor_id      TEXT NOT NULL,
  actor_name    TEXT NOT NULL,
  task_id       TEXT,
  execution_id  TEXT,
  type          TEXT NOT NULL,             -- decision | convention | gotcha | failed_attempt
                                           -- | fix | artifact_summary | steer | handoff
  scope         TEXT NOT NULL,             -- 'org' | 'project' | 'module:<path>' | 'task:<id>'
  subject       TEXT NOT NULL,             -- one-line retrievable headline
  body          TEXT NOT NULL,             -- capped ~1200 chars
  paths         TEXT[] DEFAULT '{}',       -- file footprint this fact concerns
  confidence    TEXT NOT NULL,             -- 'ruling' (human) | 'observed' (test/tool) | 'inferred' (LLM)
  valid_from    TIMESTAMPTZ NOT NULL,
  supersedes    TEXT REFERENCES knowledge_events(id),
  superseded_by TEXT REFERENCES knowledge_events(id),
  content_hash  TEXT NOT NULL,             -- dedupe on replay/backfill
  embedding     vector(256),               -- pgvector, Matryoshka-truncated
  tsv           tsvector GENERATED ALWAYS AS
                  (to_tsvector('english', subject || ' ' || body)) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON knowledge_events USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON knowledge_events USING gin (tsv);
CREATE INDEX ON knowledge_events (workspace_id, project_id, id);  -- cursor tail
```

Four properties, each load-bearing:

1. **Append-only.** Corrections are new events with `supersedes` set. Never `UPDATE`, never `DELETE`.
2. **Therefore it is a grow-only set — a CRDT for free.** Two machines that have seen the same set of IDs are in the same state, regardless of order. **This is the reason you do not need Yjs, Automerge, or Loro.** An append-only log needs a *cursor*, not a CRDT framework. Do not adopt one. (Revisit only if you later build genuinely concurrent editing of a single ruling's text.)
3. **Temporal validity** via `valid_from` + `superseded_by` — fixes §3.2. "Use Postgres" is not deleted; it is closed, and the audit trail shows who changed their mind and when.
4. **Provenance tiers** via `confidence` — a human ruling outranks an LLM inference in retrieval scoring. Fixes the "all notes are equal" problem.

### 4.2 Projections — deterministic folds, never authored

```
fold(events) → constitution.md     # active rulings only, stable order, scope-filtered
             → module_briefs/*.md  # facts scoped to a directory
             → risk_index.json     # per-file failed_attempt counts → the governance gate
             → PROJECT_MAP.md      # detected stack + structure
```

Because they are pure folds, they are regenerable and **can never drift from history** — the property that makes the log trustworthy as an audit trail. This is projectmem's core design decision and it is correct; adopt it wholesale.

### 4.2b Capability contracts — the task-handoff primitive

**This is the highest-value single artifact in the system and the current code does not produce it.**

`buildHeuristicMemory()` in `context/memory.ts` emits: task description + success criteria + a list of files touched. A downstream agent receiving that still has to **open those files to learn the signatures** — which means it still explores, which means you have not saved the tokens that matter.

Replace prose memories with a typed contract emitted on every successful task:

```jsonc
{
  "type": "capability_contract",
  "task_id": "t-…",
  "provides": {
    "modules":   ["packages/core/src/auth/session.ts"],
    "exports":   [
      "createSession(userId: string, ttlMs?: number): Promise<Session>",
      "verifySession(token: string): Promise<Session | null>",
      "type Session = { id, userId, expiresAt }"
    ],
    "routes":    ["POST /api/sessions", "DELETE /api/sessions/:id"],
    "tables":    ["sessions(id, user_id, token_hash, expires_at)"],
    "env":       ["SESSION_TTL_MS (default 86400000)"],
    "events":    ["session.created", "session.revoked"]
  },
  "invariants": [
    "token_hash is sha256; raw tokens are never persisted",
    "verifySession returns null on expiry rather than throwing"
  ],
  "deliberately_not_done": ["refresh-token rotation — deferred to t-091"],
  "entrypoints": ["packages/core/src/auth/session.ts:createSession"]
}
```

A downstream task consuming this **does not need to open a single file** to call the API correctly. That is the difference between "context sharing" and actually saving tokens.

**How to extract it (deterministic first, LLM only for intent):**

| Field | Source | Cost |
|---|---|---|
| `modules`, `entrypoints` | git diff filenames | free |
| `exports`, `routes`, `tables`, `env` | **tree-sitter** parse of the diff hunks → exported symbols + signatures | free, ~ms |
| `invariants`, `deliberately_not_done` | one **Haiku** call over diff + criteria + any decision tickets raised | ~$0.003/task |

Use `web-tree-sitter` (WASM, no native build, works under Bun). Deterministic parsing for structure, LLM only for the judgment fields — same split you already use elsewhere.

**Team dimension:** contracts are knowledge events, so they sync through the relay (§4.6). Sarah finishes the auth module on her machine; your next correlated task's pack already contains her contract. You never scan her code. This is the concrete answer to "the next person shouldn't re-scan the codebase."

**Staleness is a solved problem — see §4.2e. Do not record it; derive it from git.**

### 4.2e Git as the validity oracle — derive staleness, never record it

**Do not build "AI-native" as an assumption that every write flows through inventarium.** That assumption is false even on a team that is all-in, and every system that has claimed exclusive write access to a repo has been wrong. The mutations you will not originate:

`git revert` of an agent commit · merge-conflict resolution · rebases and cherry-picks · dependabot/renovate bumps · generated code (types, migrations, lockfiles) · a teammate using Cursor or IDE Copilot · a one-character hotfix at 2am

The gap isn't "humans typing." It's **any mutation inventarium didn't author** — and there will always be some.

#### The fix: contracts are anchored to a commit, and validity is a query

A contract is never true in the abstract. It is *true as of a SHA, for a set of paths*. Store `base_sha` alongside `provides`.

Then staleness stops being an event you must catch and becomes something you compute at pack time:

```bash
git diff --name-only <contract.base_sha>..HEAD -- <contract.paths>
```

Empty → verified current. Non-empty → drifted, and you know exactly which files moved.

**This is pull-based, so you cannot miss it.** No hook is required for *correctness*. The `post-merge` hook downgrades from a load-bearing component to a pure optimization that precomputes the answer. If it doesn't fire, if it's uninstalled, if someone clones fresh — you still get the right answer. Same principle as your deterministic projections in §4.2: never store what you can derive.

#### Hash the signatures, not the files

A raw file diff over-triggers — a reformatted comment would mark a contract stale. Instead, re-parse the changed files with tree-sitter, re-extract the signature set, and compare *its* hash:

```
signature_hash = sha256(sorted(exports ∪ routes ∪ tables ∪ env))
```

Unchanged → contract still valid despite the file edit. This kills the large majority of false staleness and is what makes the mechanism usable rather than annoying.

#### Drift self-heals — mostly for free

Detecting drift doesn't require a human, and mostly doesn't require a model:

| Contract field | Recovery | Cost |
|---|---|---|
| `modules`, `exports`, `routes`, `tables`, `env`, `entrypoints` | Re-run tree-sitter on the changed hunks | free |
| `invariants`, `deliberately_not_done` | One Haiku call — **only if `signature_hash` actually changed** | ~$0.003 |

So a hand-edited file produces a re-derived contract automatically. You lose intent, not structure.

#### Attribution is free too

`git log` / `git blame` on the changed hunks gives you author, message, and timestamp. A hand edit still becomes a knowledge event — tagged `source: 'git'`, `confidence: 'observed'` instead of `'ruling'`. Knowledge isn't lost; only the *why* is, and the `governs` edges from prior decisions still apply to the file.

Use **commit trailers**, not `git notes`, for the reverse link (`Inventarium-Contract: <id>`). Trailers survive rebase, cherry-pick, and every host; notes live in `refs/notes/*`, don't push by default, and get silently dropped.

#### The disaster-recovery property this buys you

Because contracts and the code graph are both derivable from `git history + tree-sitter`, the entire derived layer can be rebuilt from scratch on a fresh clone with the relay offline. That's a real trust story for §5.2 and a real answer to "what happens if your service dies."

#### What git cannot give you — and why that's reassuring

Git records **what was committed**. It has nothing to say about:

- **Why** — a commit message is not a ruling with provenance and a validity window
- **Failed attempts** — the three approaches that failed and were never committed are invisible to git, and those are the highest-value events in the system, because the governance gate (§4.5) runs on them
- **Uncommitted worktree state**
- **Reasoning behind an invariant**

Which lands exactly on §4.2d's split: **git is the perfect oracle for the code graph and contract validity, and useless for the knowledge graph.** Two graphs, two sources of truth, joined by `governs` edges. The fact that this falls out independently is a good sign the architecture is right.

#### The business reason to degrade gracefully

Requiring exclusive write access is an adoption blocker. A team evaluating you cannot route 100% of changes through inventarium on day one — nobody adopts that way. If the layer stays correct when half the commits come from outside it, teams can adopt incrementally, which is the only way tools actually get adopted. **Graceful degradation is a growth feature, not just an engineering nicety.**

### 4.2c Symbol index — ambient repo shape

For tasks with no explicit DAG dependency, contracts aren't enough. Maintain a lightweight symbol index:

- **Build:** tree-sitter over `git ls-files` once at init; thereafter **incremental on each execution's diff and each post-merge hook** — never a full re-scan.
- **Store:** `symbols(path, name, kind, signature, line, updated_at)` + FTS. Small; a 38k-LOC repo is a few thousand rows.
- **Serve two ways:**
  - *Push:* top-8 ranked paths into Band C (replaces your current `repo-map.ts` term-overlap ranker, which is naive — rank by symbol-name match + path overlap + recency instead).
  - *Pull:* MCP tools `find_symbol(name)`, `get_signature(path, symbol)`, `who_calls(symbol)`. **This is the important half.** Pre-stuffing guesses; tools let the agent ask precisely when your guess was wrong, at ~50 tokens per lookup instead of a 5k-token file read.

The design rule: **precompute the map, retrieve the top-k, expose tools for the rest.** Anthropic's own guidance favours agents pulling context over pre-stuffing it, and pre-stuffing is how you get context rot.

### 4.2d The graph — yes to the graph, no to the graph database

Code is natively a graph and you should exploit that. But three decisions here separate a 4-day win from a 3-week detour.

#### Decision 1: Postgres, not Neo4j

A 38k-LOC repo yields roughly 5–10k symbols and 20–30k edges. That is a *small* dataset. It fits in two Postgres tables and traverses in milliseconds via `WITH RECURSIVE`.

Adopting a graph database costs you: a second datastore, a second backup and migration story, a second sync path to the relay, loss of co-location with `pgvector` (so every hybrid query becomes a cross-database join in application code), and ops burden you do not have the headcount for. **The graph is worth having; the graph database is not.** Revisit only if traversal profiles above ~50ms at real repo scale, which it will not at this size.

```sql
CREATE TABLE graph_nodes (
  id TEXT PRIMARY KEY,              -- 'sym:packages/core/src/auth/session.ts#createSession'
  workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- file | symbol | route | table | env | module | contract | fact
  path TEXT, name TEXT, signature TEXT, line INT,
  source TEXT NOT NULL,             -- 'derived' (rebuildable) | 'asserted' (never lose)
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE graph_edges (
  src TEXT NOT NULL, dst TEXT NOT NULL,
  kind TEXT NOT NULL,               -- imports | calls | defines | references | handles
                                    -- | reads_table | governs | produced_by | decided_in
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX ON graph_edges (src, kind);
CREATE INDEX ON graph_edges (dst, kind);
```

Bounded traversal, with a cycle guard — code graphs *do* have cycles (circular imports, mutual recursion), so this is not optional:

```sql
WITH RECURSIVE walk(id, depth, path_taken) AS (
  SELECT id, 0, ARRAY[id] FROM graph_nodes WHERE id = ANY($1)   -- seeds
  UNION ALL
  SELECT e.dst, w.depth + 1, w.path_taken || e.dst
  FROM walk w JOIN graph_edges e ON e.src = w.id
  WHERE w.depth < 2 AND NOT e.dst = ANY(w.path_taken)           -- cycle guard
)
SELECT DISTINCT id, MIN(depth) AS dist FROM walk GROUP BY id;
```

#### Decision 2: two graphs, joined — not one graph

You are conflating two things with opposite lifecycles. Keep them in the same tables but tagged by `source`, and never blur the distinction:

| | **Code graph** (`source='derived'`) | **Knowledge graph** (`source='asserted'`) |
|---|---|---|
| Origin | tree-sitter over source | humans + agents (§4.1 events) |
| Truth | The code is the truth | The event log is the truth |
| On loss | Rebuild in seconds | **Unrecoverable** |
| Versioning | None — it's a cache | Temporal validity, supersession, provenance |
| Edits | Wholesale replace on diff | Append only |

If you mix them you will eventually either (a) be unable to rebuild the code graph without risking knowledge, or (b) version the code graph as if it were precious, which is wasted work. **The bridge between them is the `governs` edge:** a convention, decision, or gotcha node points at the paths and symbols it applies to.

That bridge is the whole reason to have a graph on the knowledge side. "We use conventional commits" is not usefully graph-shaped on its own — it's a flat assertion. It becomes graph-shaped the moment it's scoped: *this* convention governs `packages/server/**`. And it enables the query no vector search can answer:

> file → the contract that created it → the decision that shaped it → **the teammate who made the call**

That provenance chain is your multiplayer differentiator expressed as a query.

#### Decision 3: traverse to *rank*, not to *include*

This is where graph retrieval usually goes wrong, and it's the part of your proposal I'd push back on hardest.

Two hops from ten seeds can reach several hundred nodes. If you then summarize all of them into the prompt, you have rebuilt the context bloat you set out to kill — and added an LLM call on the critical path of every spawn.

**Rules:**

1. **The graph produces an ordered candidate list, then a hard budget cuts it.** Traversal breadth is never a reason to send more.
2. **Send signatures and paths, not summaries.** A function signature is already the optimal compression of a file: exact, deterministic, ~20 tokens, and it *prevents* the read. A prose summary is lossy in exactly the dimension (precise param names and types) that would otherwise force the agent to open the file anyway. **Never LLM-summarize what tree-sitter can extract exactly.**
3. **Summarize only what is stable and cacheable.** Your "how the software is built" instinct is right, but it belongs in Band B as a precomputed module brief / architecture overview — written once, cached at 0.10×, not regenerated per query. Right idea, wrong placement.

### 4.3 Retrieval — hybrid, budgeted, scored

Replace "concatenate everything up to 8K chars" with a **seed → expand → score → cut** pipeline. Vector search finds what is *semantically similar*; the graph finds what is *structurally connected*. Neither alone is sufficient, and the difference matters: for "I'm changing `createSession`, what breaks?", similarity is useless and call-graph edges are the exact answer.

1. **Seed** — BM25 over `tsv` (top 50) ∪ vector kNN over `embedding` (top 50) → RRF fuse → top ~10 seeds. RRF operates on ranks, not scores, sidestepping the score-incompatibility that breaks naive weighted blends.
2. **Expand** — 1–2 hop graph traversal from the seeds (§4.2d). Deterministic, no model call, milliseconds.
3. **Score** the union:
   ```
   score = rrf_or_seed_score
         × edge_kind_weight    (calls 1.0 / imports 0.8 / references 0.5 / governs 1.0)
         × distance_decay      (0.6^hops — 2 hops out is worth ~a third of a direct hit)
         × confidence_weight   (ruling 1.0 / observed 0.8 / inferred 0.5)
         × recency_decay       (half-life ~60 days; rulings never decay)
         × path_overlap_boost  (node.path ∩ task.likely_paths)
         × 0 if superseded_by IS NOT NULL OR contract.stale
   ```
4. **Cut** to the pack budget, highest score first. **Traversal breadth is never a reason to send more** (§4.2d decision 3).
5. **Emit** signatures, paths, and facts. Not file contents. Not summaries.

No cross-encoder reranker in v1. Add `bge-reranker-v2-m3` only if measurement shows this is insufficient — you will have the measurement (§5.3).

### 4.4 The three-band prompt — where the token savings actually come from

This is the highest-leverage change in the entire plan and it is mostly a *reordering*.

```
┌─ BAND A — org prefix ────────────── changes ~weekly ── CACHE BREAKPOINT (1h TTL)
│  tool definitions · inventarium system instructions · org-scope rulings
├─ BAND B — project prefix ────────── changes ~daily ─── CACHE BREAKPOINT (1h TTL)
│  project constitution (active rulings) · PROJECT_MAP · module brief for the task's dir
├─ BAND C — task pack ─────────────── per spawn ─────── NOT CACHED
│  task self · retrieved facts (§4.3) · dep memories · iteration history · steers
└─ BAND D — governance ────────────── per spawn ─────── NOT CACHED
   precheck warnings for the files this task will touch
```

Why this is the money:

- Bands A+B are **byte-identical across every task in a board run and across every teammate on the same project.** A board run is dozens of spawns. At 0.10× read cost after one 1.25× write, that is a 5–10× reduction on the cached portion of input.
- **The team makes it cheaper, not more expensive.** More teammates on the same project = more reads against the same cached prefix = lower cost per run. That is a real, defensible network effect inside a 5-person team, and it is the opposite of how every seat-based tool behaves.
- **Caveat to verify before you claim it publicly:** Anthropic caches are isolated per organization and (since Feb 2026) per workspace. Cross-teammate cache sharing therefore requires a shared org API key, not per-user `claude login` subscriptions. Confirm the current behaviour empirically before it goes in marketing copy. Within-user caching across a board run works either way and is already a large win.
- Also verify the current **minimum cacheable prefix length** (historically ~1024 tokens for Sonnet/Opus, higher for Haiku). Bands A+B must clear it or the breakpoint is a no-op.

### 4.5 Governance gate — the multiplayer feature nobody has

projectmem's contribution is *Memory-as-Governance*: memory that doesn't just answer the agent but **gates its next action**. Their gate is single-user. Yours is the team's.

New MCP tool on the existing board server:

```ts
precheck(paths: string[], plan?: string) → Warning[]
// Deterministic lookup against risk_index. No model call. No embeddings.
// → "Sarah's agent tried a null-guard here 3 days ago; verify_tests failed
//    with the same assertion. Different approach recommended."
```

Wire it two ways: injected as Band D at spawn, and exposed as a tool the agent can call mid-run. You already have `thrash.ts` (same normalized error twice) and `iteration_memories` — this generalizes both **across people and across time**, which is the part that is genuinely new.

The paper is explicit that the category has no benchmark for this. §5.3 makes you the one who builds it.

### 4.6 Sync — a cursor, not a sync engine

Since you chose relay-first:

**Source of truth:** Postgres in the relay. **Local SQLite:** a mirror plus an outbox.

```
POST /v1/events        { events: [...] }        → append, dedupe on content_hash
GET  /v1/events?since=<ulid>&project=<id>       → tail, returns next cursor
GET  /v1/events/stream?since=<ulid>             → SSE live tail
```

That is the entire sync protocol. Offline: writes go to the local outbox; on reconnect, push everything unsent (append-only ⇒ no conflict resolution needed) and pull from the last cursor. **~150 lines, not a sync engine.**

Do **not** reach for ElectricSQL / PowerSync / Zero / LiveStore. Those solve bidirectional sync of *mutable* rows. You deliberately don't have mutable rows. Adopting one would be adding a multi-quarter platform commitment to solve a problem you designed away.

**`state.json` is separate and still broken (§3.4).** Fix it independently: move task mutations to the event log too (`task_updated` events with per-field last-writer-wins on field-level HLC), or accept row-level LWW and warn in the UI. Do not let this block the knowledge layer.

### 4.7 Stack — concrete picks

| Layer | Pick | Why |
|---|---|---|
| Relay DB | **Neon** (serverless Postgres, pgvector supported, DB branching) | Solo-friendly ops, branch-per-PR, scales to zero |
| ORM/migrations | **Drizzle** | TS-native, plays with Bun, real migration files (you're overdue — `try{ALTER}catch{}` was flagged in your own feedback doc) |
| Vector | **pgvector** + HNSW | Already in Neon; no extra extension |
| Lexical | **Postgres native `tsvector`** + RRF | Zero extra extensions. ParadeDB/VectorChord BM25 is better but adds a dependency managed Postgres may not allow — defer until measurement demands it |
| Local mirror | **bun:sqlite** + **sqlite-vec** + **FTS5** | Same query shape offline; sqlite-vec is SIMD-accelerated and dependency-free |
| Embeddings | **nomic-embed-text** via fastembed locally (137M params, 274MB, 8192 ctx, Matryoshka → 256 dims) | Runs on a laptop, keeps the offline story honest, small index. Optional cloud upgrade to a code-tuned model later; **BGE-M3 + bge-reranker-v2** is the 2026 self-hosted default if you outgrow it |
| Realtime | **SSE** (already built) + Postgres `LISTEN/NOTIFY` for multi-instance fanout | No new dependency; you already have the bus |
| Auth | **better-auth** (GitHub OAuth) | Keeps your Hono stack; no vendor client SDK |
| Billing | **Stripe**, seat-based, 14-day trial, no card | Standard |
| CRDT library | **none** | §4.2 property 2 |

---

## 5. Making it saleable

### 5.1 Packaging

| Tier | Price | Contents |
|---|---|---|
| **OSS (MIT)** | $0 | Board, execution, TDD gate, `ask_human`, local knowledge log, projections, retrieval, governance gate, git export. Genuinely the best local agent orchestrator, full stop. |
| **Team Cloud** | **$20/user/mo** | Relay, live session join, presence, cross-machine knowledge sync, shared decision inbox + notifications, token/cache dashboard, 90-day history |
| **Business** | $40/user/mo | SSO, RBAC, org routing policies, cost analytics, audit log, deploy approvals |

Anchors hold: Cursor Teams $40/user/mo, Devin Teams $80 + $40/seat. At $20 you're an add-on line item, not a platform decision.

### 5.2 The trust story — and the objection you must answer honestly

Your line is "we host coordination, not compute — your code never touches our servers." That is true of *code*. It is **not** true of knowledge events, which contain summaries of decisions, file paths, and error output. A security-conscious team will catch this immediately, and if your marketing overclaims they will not come back.

Mitigations, all shippable:

- **Secret redaction on the write path, default on.** Copy projectmem's approach: anchored patterns for `sk-`, GitHub tokens, `AKIA`, `AIza`, Slack/Stripe tokens, JWTs, PEM headers. Redact before anything touches disk *or* the wire. Pin it with true-positive AND false-positive tests so ordinary debugging prose is never mangled.
- **Per-project `sync: local-only`** flag — knowledge stays on the machine, board still syncs.
- **`inventarium knowledge export`** → plain JSONL + regenerated markdown. Your data, always ejectable. This is also your git-tier fallback if the relay thesis fails.
- **Self-host** the relay (it's ~500 lines and a Postgres URL).

Publish all four before you take a dollar.

### 5.3 The benchmark — your best marketing asset

The projectmem paper states plainly that its own token figures are "usage estimates over ranges, not a controlled benchmark," and names a controlled repeat-failure benchmark as the single most valuable next result, one the dev-tool memory category currently lacks.

**Build it. Ship it. Name it.**

`inventarium bench` over a seeded corpus, reporting:

| Metric | Definition |
|---|---|
| **tokens/task vs naive baseline** | Same task, packer on vs constitution-dump on |
| **discovery tool calls** | Glob/Grep/Read calls spent *finding* things before the first edit. **The headline metric** — this is the number §4.0 exists to drive to zero |
| **cache hit rate** | Cached-read tokens ÷ total input tokens |
| **repeat-failure prevention rate** | Fraction of seeded, previously-failed fixes the gate blocks |
| **context-reuse rate** | % of task packs containing ≥1 fact authored by a *different* teammate — this is the multiplayer metric and nobody reports it |
| **time-to-first-green** | Task start → verify_tests passes |
| **$ per merged PR** | The number a buyer actually cares about |

"We built the first benchmark for team context layers, here are our numbers, here's the harness" is a dramatically stronger Show HN than "we built a memory layer." It also converts your differentiation from a claim into a measurement, which is the difference between a blog post and a moat.

### 5.4 Competitors — be specific, don't hand-wave

| Who | What they have | Where you win |
|---|---|---|
| **Byterover** | Shared memory layer for dev teams, project workspaces, permission settings, memory pruning; works with Cursor/Windsurf/VS Code/Zed/Cline | They store memories someone writes. You *generate* them from execution. Plus: no live sessions, no governance gate, no TDD gate |
| **BuildBetter CLI** | Cross-agent memory + team skills across Claude Code/Cursor/Codex/Copilot/Gemini | Same: capture is manual. Broader agent coverage than you — this is the argument for finishing your Codex adapter |
| **projectmem** | Event-sourced local memory, **shipped `precheck` gate**, 14 MCP tools, cross-project gotchas, ROI score, MIT | Closest architectural relative — read their README before you build. They gitignore the raw log, so team sharing is a lossy snapshot: no attribution, no merge, no live propagation, no retrieval (deliberately no embeddings). Note: their gate and ROI score already exist, so **do not claim those as novel** — claim the *multiplayer* versions |
| **AGENTS.md** | Static conventions file, ~60k repos, donated to Linux Foundation's Agentic AI Foundation Dec 2025 | Static, no temporal validity, no retrieval, no attribution. **Emit an `AGENTS.md` projection anyway** — meet the standard, don't fight it |
| **Anthropic / Cursor shipping native team memory** | The real risk | Mitigate by being agent-agnostic and owning the *execution-derived* capture loop, which is orthogonal to any one vendor |

---

## 6. Execution plan — 12 weeks, full-time solo

Each phase ends in something demoable. If a phase slips, cut scope inside it; do not slide the next phase.

### Week 0 (3 days) — clear the launch debt. Non-negotiable.

Not housekeeping. You cannot recruit design partners for a multiplayer dev tool from a repo with 0 stars, no npm package, and a README that says `git clone` when the product does `npx`.

- [ ] README rewritten to match reality: `npx inventarium --demo` above the fold, current feature set, current roadmap
- [ ] `npm publish` — the P0 your own release plan named and skipped
- [ ] GitHub Release for v1.0.0, repo description, topics
- [ ] File the 10 drafted good-first-issues from `.github/GOOD_FIRST_ISSUES.md`
- [ ] Clean-machine E2E on the Phase 3/4/5 code (never done)
- [ ] Archive the 10 stale internal docs

**Gate: do not start Week 1 until `npx inventarium` works on a machine that is not yours.**

### Weeks 1–2 — Substrate + minimal relay

- [ ] `knowledge_events` schema (§4.1) in Postgres + mirrored SQLite; Drizzle migrations
- [ ] `packages/core/src/knowledge/` — `append()`, `fold()`, `project()`, ULID, content-hash dedupe, secret redaction
- [ ] Emit events from all five existing sources (§2) — no new UI required
- [ ] Backfill: your 130 existing memories in `.inventarium/context/memories/` + `decisions.md` + git history
- [ ] Deterministic projections replace `loadConstitution()` — fixes §3.1 and §3.2
- [ ] **Capability contracts (§4.2b)** — tree-sitter extraction + Haiku intent pass; replaces `buildHeuristicMemory()` as the dependency payload
- [ ] **Symbol index + code graph (§4.2c, §4.2d)** — tree-sitter → `graph_nodes` / `graph_edges` in Postgres; initial build + incremental update on execution diff; recursive-CTE traversal with cycle guard
- [ ] `governs` edges linking knowledge nodes to the paths/symbols they scope
- [ ] **Git validity oracle (§4.2e)** — `base_sha` on every contract, `signature_hash` comparison at pack time, tree-sitter re-derivation on drift, commit trailers. The `post-merge` hook is an optimization only — correctness must not depend on it firing
- [ ] Relay: `POST /v1/events`, `GET /v1/events?since=`, GitHub OAuth, workspace model
- [ ] Local outbox + cursor sync

**Demo (two, record both):**
1. *Task handoff:* task A builds an auth module; task B consumes it and calls the API correctly **with zero exploratory tool calls**. Show the before/after tool-call count on the same task. This is the core value prop — prove it in week 2, not week 6.
2. *Team handoff:* two machines, one workspace. Answer a decision ticket on machine A; machine B's next spawn inherits it without a git push. **First multiplayer moment.**

### Weeks 3–4 — Live multiplayer (the YC demo)

- [ ] SSE fanout moved to the relay, scoped per workspace + Postgres `LISTEN/NOTIFY`
- [ ] Presence: who's watching which task, avatars on cards
- [ ] Live session join: open a teammate's running task, see the feed mid-stream
- [ ] Shared steering queue with attribution — anyone can redirect anyone's agent
- [ ] Shared decision inbox — any teammate answers any ticket; browser + email notification
- [ ] Handoff: reassign a running task to another human owner

**Demo:** the 90-second video. Two people, one board, one agent running. Person A starts it, walks away. Person B joins the live session, answers the decision ticket, steers it, takes over. Every one of those actions becomes a knowledge event visible in the next spawn. **This is the YC application video and the Show HN GIF.**

### Weeks 5–6 — Retrieval + cache-aware packer + the number

- [ ] Embedding pipeline (fastembed / nomic-embed-text, 256-dim Matryoshka), on append
- [ ] Hybrid retrieval + RRF + domain re-scoring (§4.3)
- [ ] Three-band prompt assembly with explicit cache breakpoints (§4.4)
- [ ] Verify minimum cacheable prefix length and cross-user cache behaviour empirically
- [ ] Token + cache dashboard: tokens/task, cache hit rate, $ per task, **context-reuse rate**
- [ ] A/B harness: dump-mode vs packer-mode on identical tasks

**Demo:** a chart. "Same board, same tasks: 41% fewer input tokens, 71% cache hit rate, $0.34 → $0.11 per task." Real numbers from your own repo — you have 594 replay fixtures to replay against.

### Week 7 — Governance gate, multiplayer

- [ ] `risk_index` projection
- [ ] `precheck(paths, plan)` MCP tool + Band D injection
- [ ] Cross-teammate attribution in warnings

**Demo:** "Sarah tried this 3 days ago; it failed." Show it firing on a real repeat.

### Week 8 — Trust + hardening

- [ ] Secret-redaction test suite (true + false positives)
- [ ] `sync: local-only` per project
- [ ] `inventarium knowledge export` → JSONL + markdown + `AGENTS.md` projection
- [ ] Self-host docs for the relay
- [ ] Fix `state.json` LWW (§4.6)

### Weeks 9–10 — Benchmark + design partners

- [ ] `inventarium bench` harness + seeded corpus (§5.3)
- [ ] Publish the harness and your numbers
- [ ] Onboard your 1–2 people properly; then recruit 3 more small teams from your issue tracker, the Claude Code Discord, and r/ClaudeAI
- [ ] Stripe seat billing, 14-day trial

**Gate: do not launch until ≥2 teams that are not you have run a real task through a shared board.** A multiplayer product with no multiplayer usage is a demo.

### Weeks 11–12 — Launch

- [ ] Show HN, Tue–Thu 8–10am ET. Title: *"Show HN: inventarium – Multiplayer AI coding agents with a shared team memory"*. First comment ready: the YC RFS framing, the benchmark numbers, the projectmem future-work alignment
- [ ] Blog: "We built the first benchmark for team context layers"
- [ ] Blog: "Your team's agents should share a brain — here's the architecture"
- [ ] Product Hunt the following week
- [ ] Next YC batch application, with usage data

---

## 7. Risks, ranked by how likely they are to kill this

**1. You build all 12 weeks and never launch. (Highest, by a distance.)**
Precedent: 11 plan docs, ~38k LOC, v1.0.0 tagged July 5, launch scheduled July 7, and on July 28 the repo has 0 stars and isn't on npm. And the closest competitor, projectmem — shipped, documented, on PyPI, with a marketing site — also has 0 stars. **In this category, the build is not the bottleneck; distribution is.** The Week 0 gate and the Week 10 gate exist specifically for this. Put the Show HN date in your calendar today and treat it as immovable.

**2. Multiplayer validated solo.** Two people is thin. If your 1–2 partners go quiet by Week 6, stop building and go recruit before writing another line.

**3. Byterover / BuildBetter get there first.** Both ship team memory today. Your differentiator is execution-derived capture + the governance gate + live sessions. If you can't articulate that in one sentence to a stranger, you don't have it.

**4. Anthropic or Cursor ships native team memory.** Real. Mitigate by owning the capture loop (vendor-orthogonal) and finishing the Codex adapter so you're not a Claude Code accessory.

**5. Token savings don't materialize.** Everything in §1 signal 3 is an estimate from the literature, not your measurement. Build the benchmark in Week 5–6 and let it tell you the truth. If the number is 15% and not 60%, say 15% — a measured 15% beats an estimated 60% with buyers, and the honesty is itself differentiating in a category full of hand-waving.

**6. Privacy objection stalls enterprise-adjacent teams.** Answered in §5.2, but only if you ship all four mitigations *before* charging.

---

## 8. The 60-second pitch

> Your team runs Claude Code all day. Every decision, every dead end, every convention lives in someone's private terminal session and dies there. New agent, new session, same questions.
>
> inventarium is a kanban board where your agents do the work in the open. Anyone on the team can drop into a running agent session, watch it, redirect it, answer its questions, hand it off.
>
> And because every one of those interactions is captured, your team's knowledge writes itself. The next agent — anyone's agent — inherits it. It won't repeat the fix that failed for your teammate on Tuesday.
>
> That shared context is also a cached prompt prefix, so the more of your team uses it, the less each run costs. Most tools get more expensive per seat. This one gets cheaper.

---

## 9. Sources

**YC RFS Fall 2026**
- [Requests for Startups — Y Combinator](https://www.ycombinator.com/rfs) (Multiplayer AI, by Aaron Epstein)
- [YC Fall 2026 Applications: July 27 Deadline](https://beststartup.us/yc-fall-2026-applications-deadline/)
- [YC Application Deadlines 2026–2027](https://www.roundfunded.com/en/blogs/yc-application-deadlines-2026-2027)

**Agent memory + coding-agent context**
- [PROJECTMEM: A Local-First, Event-Sourced Memory and Judgment Layer for AI Coding Agents (arXiv 2606.12329)](https://arxiv.org/pdf/2606.12329)
- [State of AI Agent Memory 2026 — Mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Mem0 vs Zep vs Letta compared](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- [Agent Memory Frameworks in 2026: Memory vs. Context — Graphlit](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [How to Share AI Coding Context Across Your Team in 2026 — BuildBetter](https://blog.buildbetter.ai/how-to-share-ai-coding-context-across-your-team-in-2026/)
- [ByteRover CLI: The Memory Layer AI Coding Agents Desperately Need](https://www.blog.brightcoding.dev/2026/06/05/byterover-cli-the-memory-layer-ai-coding-agents-desperately-need)
- [AGENTS.md Complete Guide for Engineering Teams (2026)](https://blog.buildbetter.ai/agents-md-complete-guide-for-engineering-teams-in-2026/)

**Token economics + context engineering**
- [Prompt Caching Deep Dive: How to Cut Anthropic API Costs by 90%](https://agentbrisk.com/blog/prompt-caching-deep-dive-2026/)
- [Prompt Caching in 2026: Anthropic, OpenAI, Azure Compared](https://technspire.com/en/blog/prompt-caching-2026-real-cost-wins)
- [Context Engineering: Why More Tokens Makes Agents Worse — Morph](https://www.morphllm.com/context-engineering)
- [Context Engineering: Agent Reliability Playbook 2026](https://www.digitalapplied.com/blog/context-engineering-agent-reliability-playbook-2026)

**Retrieval + storage**
- [Hybrid Search: BM25, Vector & Reranking Reference 2026](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026)
- [Hybrid Search in PostgreSQL: The Missing Manual — ParadeDB](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual)
- [The State of Vector Search in SQLite](https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite)
- [The Best Open-Source Embedding Models in 2026 — BentoML](https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models)

**Sync / local-first**
- [Yjs vs Automerge vs Loro: CRDT Libraries 2026](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026)
- [ElectricSQL vs PowerSync vs Zero: Best Local-First Sync Engine (2026)](https://trybuildpilot.com/648-electric-sql-vs-powersync-vs-zero-2026)
- [The Architecture of Local-First Web Development — Smashing Magazine](https://www.smashingmagazine.com/2026/05/architecture-local-first-web-development/)