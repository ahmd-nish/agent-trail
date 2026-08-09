# Show HN — launch kit

**Timing:** Tue / Wed / Thu · 8–10am ET · watch [hnpickup.com](https://hnpickup.com/) for slack.

**Title (69 chars, under HN's 80 limit):**

> Show HN: inventarium – Multiplayer AI coding agents with a shared team memory

**Submission URL:** https://github.com/ahmd-nish/inventarium

**Post body (goes below the URL — HN hides it behind "more" but people click):**

I built inventarium because every team-memory tool asks people to write down what they know. inventarium already watches them do the work — so the knowledge writes itself, and every teammate's agent inherits it.

Drop a PRD → get a task graph → watch Claude Code execute each task in an isolated worktree under a TDD gate, with a live activity feed. When the agent hits a judgment call, it pauses and asks a human via the `ask_human` MCP tool. Every one of those answers, every failed test attempt, every thrash detection, every steer becomes a durable, attributed knowledge event that shows up in the next agent's prompt.

Written in TypeScript / Bun. MIT. Local-first — nothing phones home; SQLite is the substrate; a JSONL export/import round-trip so your data is always ejectable.

## First comment (post this yourself, within 5 minutes)

> Author here. Some context that didn't fit in the post:
>
> **Why now.** YC's Fall 2026 RFS "Multiplayer AI" (Aaron Epstein) reads like a spec for what I'd already half-built: "Anyone on a team should be able to drop into the same live agent session to watch it work, redirect it, and hand it off." The paper closest to my architecture — PROJECTMEM (arXiv 2606.12329, Malo & Qiu, June 2026) — lists multi-user log sync as future work item #5. So the category exists, the shape is validated, but nobody has shipped the multiplayer version.
>
> **The one honest number I have.** projectmem shipped on PyPI with docs and 0 stars. Cursor / Byterover / BuildBetter all ship team memory today. In this category the build is not the bottleneck; distribution is. That's why I'm here.
>
> **What's actually novel.** Not the memory layer — that's projectmem's contribution and I credit them openly in the plan doc. What's new is: (a) *execution-derived* capture — humans answer decision tickets they were going to answer anyway; agents fail tests they were going to fail anyway; both become events. (b) A team-wide governance gate: "Sarah's agent tried this on `auth/session.ts` 3 days ago; verify_tests failed with the same assertion." projectmem's gate is single-user. (c) A three-band prompt whose stable prefix means more teammates on the same project = lower per-run cost, not higher. The opposite of every seat-based tool.
>
> **What's not novel and I don't claim it is.** The `precheck` gate mechanism, ROI scoring, event-sourced local memory, deterministic projections — all from projectmem. Read their paper before mine.
>
> **What's shipped, what's not.** The event log, five emission points (decisions, failed_attempts, gotchas, steers, artifact_summaries), FTS5-ranked retrieval, foldConstitution replacing the alphabetized dump, MCP tools for cross-teammate `precheck`, an AGENTS.md projection, a bench harness reporting real numbers from live telemetry. Not yet shipped: the relay (so "multiplayer" today means a shared DB), the code-graph half of retrieval, capability contracts, embeddings + vector kNN.
>
> **One number from my own repo (single-actor):** 7 tasks completed 100%, 2.7M input tokens across 9 executions, 49s avg time-to-first-green, 0 thrash. Multi-actor benchmark numbers will follow when the design partners' logs land — which is exactly what I'm looking for now.
>
> **What I want from HN:** design partners (small teams already running Claude Code together), critical feedback on the architecture doc (`docs/knowledgelayer.md` in the repo), and anyone who's built one of the frameworks I'm citing (please tell me if I'm mis-characterizing your work).
>
> Repo: https://github.com/ahmd-nish/inventarium
> Plan doc: https://github.com/ahmd-nish/inventarium/blob/main/docs/knowledgelayer.md
> Benchmark: https://github.com/ahmd-nish/inventarium/blob/main/packages/core/src/knowledge/bench.ts

## Answering the standard HN objections

**"How is this different from Byterover / BuildBetter / projectmem?"**
Byterover and BuildBetter store memories someone writes; inventarium generates them from execution. projectmem is the closest architectural relative and ships the single-user version — multiplayer sync is their explicit future-work item. Details in `docs/knowledgelayer.md` §5.4.

**"What happens to my data?"**
Local-first. SQLite. Nothing phones home. Every event is redacted for secrets on the write path before it hits disk. `inventarium knowledge export` writes JSONL + regenerated markdown + AGENTS.md at any time. Per-project `sync: local-only` flag lands with the relay.

**"Is this a wrapper around Cursor / Claude Code?"**
It orchestrates Claude Code today because that's what has stream-json and MCP support. The adapter interface in `packages/core/src/adapters/` is the extension point for Codex and Gemini CLI — the biggest pending contribution.

**"What's the pricing model?"**
OSS MIT, always, for the local board + governance gate. Team Cloud ($20/user/mo) adds the relay, presence, cross-machine sync, and the token/cache dashboard. Business tier for SSO/RBAC/audit. See `docs/knowledgelayer.md` §5.1.

**"Why should I trust the token numbers?"**
Read the caveat in `docs/knowledgelayer.md` §4.0 — the estimates in the doc are literature-derived, not measured. The bench harness reports live numbers over your own telemetry. A controlled A/B against dump-mode is the next benchmark; deliberately deferred until there's a seeded corpus.
