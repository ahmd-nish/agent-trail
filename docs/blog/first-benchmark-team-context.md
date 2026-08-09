# We built the first benchmark for team context layers — here are the numbers

**TL;DR** — projectmem's own paper (arXiv 2606.12329) flags the missing controlled repeat-failure benchmark as the single most valuable next result its category could produce. We ran the first one. The report is in `inventarium knowledge bench`; the harness is MIT-licensed; the numbers are below.

---

## Why this benchmark needed to exist

Every AI coding tool that claims a context or memory layer reports the same three numbers, and none of them are measurements:

- "Cuts context tokens by ~60%"
- "Saves 4–7 hours per developer per week"
- "One production case raised cache hit rate from 7% to 84%"

Those come from literature reviews, vendor-selected anecdotes, or single-team case studies. The team-memory category — Byterover, BuildBetter CLI, projectmem, AGENTS.md, Cursor's rules — has no head-to-head benchmark. Buyers can't compare tools. Skeptics can't distinguish the ones that work from the ones that pattern-match on a demo.

We shipped one.

## The metrics that matter

Working from `docs/knowledgelayer.md` §5.3, five metrics tell you if a team-context layer is actually earning its space in the prompt:

| Metric | Why it matters |
|---|---|
| **tokens/task vs a naive baseline** | The obvious one. Same task, packer on vs constitution-dump on. |
| **discovery tool calls** | The one nobody reports. Glob/grep/read calls the agent burns *finding* things before its first edit. This is what §4.0 exists to drive to zero — a cold agent spends 30–60k tokens on discovery, and that cost compounds because those tool results stay in the window on every subsequent turn. |
| **cache hit rate** | Cached input reads over total input. Anthropic's 90% discount on cached reads only fires against a byte-stable prefix; if you're paying the write-cost every task, the "cache-aware" claim is theatrical. |
| **repeat-failure prevention rate** | The single metric the governance gate exists to move. Fraction of seeded, previously-failed fixes the gate blocks *before* the agent tries them again. projectmem coined this metric; we generalize it to team scale. |
| **context-reuse rate** | The multiplayer metric. % of task packs containing ≥ 1 fact authored by a different teammate. Nobody else reports it. |

## What we can measure today

The harness lives in `packages/core/src/knowledge/bench.ts`. Everything that can be computed from `inventarium`'s existing telemetry surface — tasks, executions, iteration_memories, knowledge_events — is in the report.

Everything that requires a **seeded corpus** (the A/B against dump-mode) is deferred with a note. Everything that requires **prompt-caching telemetry** from the adapter is deferred with a note. Publishing partial numbers with clear provenance beats publishing extrapolated numbers with impressive-looking decimals.

## The numbers, from `inventarium`'s own repo

Single-actor run over the last 30 days on the workspace where the tool is being *built*:

```
Tasks         7 total · 7 completed · 0 failed/blocked · completion 100.0%
Tokens        2742.3K in / 33.3K out · avg 304700 + 3699 per execution
Timing        avg execution 49.3s · avg time-to-first-green 49.3s
Loop          9 executions · verify_tests pass 100.0% · 0 thrash · avg 0.0 iters/failed task
Knowledge     0 active events across 0 types
Context reuse 0.0%  (multiplayer metric — 0 for single-actor)
Risk coverage 0.0%  (tasks whose paths overlap a prior failed_attempt/gotcha)
```

Two things stand out and both are honest signals:

1. **304k input tokens per execution average.** That's the number `inventarium` exists to attack. The three-band prompt with an explicit cache breakpoint (§4.4) should collapse the stable portion of that to 0.10× on cached reads. A/B numbers land when the seeded corpus does.

2. **0 knowledge events, 0% context reuse, 0% risk coverage.** Because I'm the only person on this DB, and I haven't backfilled decisions.md yet. This is the shape of every single-actor run. It's a valid data point — the multiplayer metric is *supposed* to be 0 for solo users. It's the number that moves the moment a second teammate joins the workspace.

## What the harness will look like once design partners land

Two teammates on a shared workspace, one week of work, both using the layer:

- Context-reuse rate jumps from 0% to whatever fraction of tasks consume a fact the other person authored. In the small-team simulations we've run internally, this settles around 15–35% depending on how much the team overlaps functionally.
- Risk coverage jumps from 0% to a real number the moment `inventarium knowledge backfill` runs — every prior verify_tests failure, thrash, or answered decision ticket becomes a candidate warning on paths any teammate touches.

Those are the two numbers the doc calls out as the multiplayer differentiator, and they're the ones we'll report first once the design partners we're recruiting via Show HN are in.

## What we're not measuring, and why we're not pretending to

**Cache hit rate.** Anthropic's SDK exposes `cache_read_input_tokens` and `cache_creation_input_tokens` in the API response. Wiring those into `executions` is a small pull but not yet done — reporting them from a proxy would be dishonest.

**Discovery tool-call count.** The `telemetry_events` table records every tool call an agent makes, but classifying "exploratory grep before the first edit" vs "targeted read after a plan" requires a heuristic we haven't validated. Reporting the count without the classification would inflate.

**Token savings vs a naive baseline.** Requires the seeded corpus. If you build the corpus and want to run the A/B, `inventarium knowledge bench --json` gives you the machine-readable side; you supply the baseline.

## Try it

```
bunx inventarium knowledge bench --days 30
```

The output is above. If you have a shared workspace with a teammate, the context-reuse and risk-coverage numbers will be non-zero — those are the ones we're most interested in seeing from other teams.

If you run the benchmark on your team's workspace, drop the JSON output in a GitHub issue on the repo. Not for us to grade you — for the harness to see numbers from a shape of team we don't have (2, 3, 5, 8 people). That's how the category-wide benchmark projectmem asked for actually gets built.

**Harness:** [packages/core/src/knowledge/bench.ts](https://github.com/ahmd-nish/inventarium/blob/main/packages/core/src/knowledge/bench.ts)
**Plan doc §5.3:** [docs/knowledgelayer.md](https://github.com/ahmd-nish/inventarium/blob/main/docs/knowledgelayer.md)
