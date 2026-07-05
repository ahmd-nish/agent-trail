# 30-day plan — agent-trail v0.2.0

**Start date:** D1 (calendar TBD — currently 2026-05-23)
**Target ship date:** D30
**Strategy:** Open-core SaaS. Free OSS for solo CLI agent users → paid collab tier later.

---

## The bet

Make agent-trail the **most fun place to manage tasks for people who code with CLI agents** (Claude Code, Codex, Aider, etc.).

Win condition: a solo dev installs it, runs one task, watches the activity feed, and tweets the GIF unprompted. Their friends see it and install it. The funnel from "saw it on Twitter" → "running my own task" is under 90 seconds.

We're not selling. We're letting the tool sell itself.

---

## The 4 product pillars

1. **Cinematic activity feed** — watching an agent run feels like watching a movie, not reading logs. Typewriter text, animated tool cards, sound, notifications. This is the wedge.
2. **Bundled agent + skill library** — ship 6 curated reusable subagents and 4 skills out of the box. Per-task assignment in the UI. Open-source `.md` files anyone can fork.
3. **Project knowledge** — board-level shared context auto-injected into every task. Grows automatically from completed task artifacts. Free-tier solo version; cross-team RAG is the paid wedge.
4. **Human-in-the-loop polish** — `ask_human` becomes the most polished interrupt mechanism in the agent ecosystem. Browser notifications, sound, beautiful ticket UI, mobile-friendly answer flow.

---

## Week-by-week

| Phase | Days | Theme | Wow moment |
|-------|------|-------|-----------|
| Foundation | D1–2 | Rename, timeout, multi-tenant groundwork, DAG removal | Clean baseline |
| Week 1 | D3–9 | Cinematic activity feed + sound + notifications | First task you watch makes you smile |
| Week 2 | D10–16 | Bundled agent library + skill discovery + per-task assignment | Assign `pr-reviewer` subagent and watch it review |
| Week 3 | D17–23 | Project knowledge: editor + auto-inject + auto-extract learnings | Board accumulates real docs without typing |
| Week 4 | D24–30 | Templates, stats, onboarding, launch | HN post → first 100 stars |

Each week has its own `docs/week-N-*.md` with a daily breakdown.

---

## Don't-do list (this month)

- **No cloud collab.** Phase 2 (paid).
- **No auth.** Phase 2. Use `workspace_id = "local"` everywhere.
- **No audit/enterprise pivot.** Different product, different time.
- **No Codex/Gemini adapters.** v0.2.x. The adapter seam is in place; resist the urge.
- **No VS Code extension.** v0.3.
- **No DB schema redesign.** Additive only.
- **No DAG view.** Deleted in foundation.

---

## What survives from v0.1

Everything else. Keep:
- 6-column kanban
- Epic view (the user explicitly asked to keep it)
- TDD gate runtime (write_tests / implement / verify_tests phases) — but consider hiding the machinery in the UI for non-TDD users in Week 4
- DAG planner (the data structure, not the visualization)
- Per-task MCP scoping
- Worktree manager + runner package
- All current routes, db schema (additive changes only)

---

## Multi-tenancy groundwork (Phase 2 setup)

Spread across all 4 weeks. Every new table or column added this month MUST include `workspace_id TEXT NOT NULL DEFAULT 'local'`. Every server route MUST route through a `getCurrentUser()` helper that returns `{ id: 'local', workspaceId: 'local' }` for now. Free tier always uses `'local'`. The day Phase 2 ships, swapping this is a config change, not a migration nightmare.

---

## Definition of "v0.2.0 ready to ship"

By end of D30, all of these are true:

- [ ] `agent-trail` name lands everywhere (no `vibe-board` references in user-facing strings)
- [ ] First-time visitor → working sample task in under 90s, zero typing
- [ ] Activity feed has typewriter animation, color-coded tool cards, and a working sound system
- [ ] 6 bundled subagents installed under `packages/core/src/agents/library/`, assignable from task UI
- [ ] Project knowledge editor working + auto-inject into system prompt + at least manual learning extraction
- [ ] 5 starter templates with one-click clone
- [ ] Stats dashboard on every board
- [ ] Browser notifications + favicon badge + tab title pulse for ask_human and task complete
- [ ] README rewritten around the 4 pillars + GIF + 3 screenshots
- [ ] Published to npm as v0.2.0
- [ ] HN post + Twitter thread drafted

If any of these slip, **ship anyway**. Better v0.2.0 lite than a delayed v0.2.0 perfect.

---

## Weekly review ritual

End of each week, answer in writing:

1. Did the "wow moment" land? Record a 30-sec video — does it still feel right?
2. What broke that wasn't expected?
3. What did I cut? What did I add?
4. Is the bet still right?

Save reviews as `docs/week-N-review.md`.

---

## Roadmap after v0.2.0 (do NOT start before D30)

- v0.3.0 — Codex / Aider / Gemini adapters
- v0.4.0 — VS Code extension
- Phase 2 (paid SaaS) — cloud sync, shared workspace knowledge with RAG, hosted ask_human notifications via Slack/Discord/push, cross-board cost dashboard

The OSS tool stays free forever. The paid layer is value-additive (sync + collab + cross-workspace intelligence), not feature-gating.
