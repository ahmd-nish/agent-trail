**The kanban board where your team's AI coding agents share a brain.**

Formerly `agent-trail`. This release is the reason for the rename: agents no longer just run in parallel — they inherit what the team already learned.

```bash
npx inventarium          # launch the board
npx inventarium --demo   # replay mode against bundled fixtures
```

## The shared knowledge layer

Every other team-memory tool asks people to *write down* what they know. Inventarium already watches them do the work, so the knowledge writes itself and every teammate's agent inherits it.

- **It writes itself.** Decisions, failed attempts, gotchas, steers and capability contracts become typed events as work happens.
- **Capability contracts.** A finished task emits the exact signatures it produced, so the next task calls the API without opening a file.
- **Governance gate.** Before an agent touches a file it is told what already failed there — across tasks and across teammates.
- **The knowledge graph.** Knowledge joined to the code it governs: *what governs the files I'm about to change*, and *what breaks if I change `createSession`* — the blast radius through callers, crossed with the rulings that apply to them.
- **Contracts stay honest.** Validity is derived from git, so a signature changed by a rebase, a hotfix, or a teammate on another tool is reported as drifted and re-derived, never trusted stale.
- **Cross-machine sync.** An append-only log with a cursor. Answer a decision on your laptop; your teammate's next spawn inherits it, with no git push. No CRDT, no sync engine — the data model made both unnecessary.
- **Workspaces, roles, tokens.** Per-user credentials scoped to one workspace, stored hashed. Scope is derived from the credential, never read from the request.
- **Visual explorer.** A `graph` tab: pan, zoom, filter by type or author, search, focus on any node's neighbourhood.

Setup for a team: [docs/TEAM_SETUP.md](https://github.com/ahmd-nish/inventarium/blob/main/docs/TEAM_SETUP.md). Architecture: [docs/knowledgelayer.md](https://github.com/ahmd-nish/inventarium/blob/main/docs/knowledgelayer.md) and [knowledgelayer-v2.md](https://github.com/ahmd-nish/inventarium/blob/main/docs/knowledgelayer-v2.md).

## Also in this release

- Cost is now cache-aware (a cache read bills at 0.1x) — the previous figure overstated cache-heavy runs by >1.5x
- A metric worth owning: **cross-actor governance rate** — the fraction of tasks whose context included a fact authored by *someone else* and attached to a file the task actually modified. Presence is vanity; this measures relevance.
- On-disk names migrate automatically (`agent-trail.db` → `inventarium.db`, `.agent-trail/` → `.inventarium/`), and `AGENT_TRAIL_*` env vars still work with a deprecation warning

## Fixed

Four of these were live defects that a fully green test suite could not see:

- **Thrash detection missed genuine repeats (~1 in 4)** — the loop kept burning tokens on a fix that could not converge
- **Optimistic locking silently lost concurrent writes** — two writes in the same millisecond were indistinguishable
- **Every knowledge event carried an empty file footprint**, which silently disabled the governance gate
- Contracts embedded whole function bodies instead of signatures, and missed re-exports, `export default` and multi-line union types

Each surfaced within minutes of running the real product. `real-stack-e2e.test.ts` now drives the actual CLI and server as processes to cover that seam.

## Upgrading from agent-trail

Nothing to do. Your database and state directory are renamed in place on first run, and the old env vars keep working. Package names changed: `@agent-trail/cli` → `inventarium`, `@agent-trail/core` → `@inventarium/core`, `@agent-trail/server` → `@inventarium/server`.

**Full changelog:** [CHANGELOG.md](https://github.com/ahmd-nish/inventarium/blob/main/CHANGELOG.md)
