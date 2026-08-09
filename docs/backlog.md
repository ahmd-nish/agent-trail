# Backlog

Deferred deliberately, with the reason. Ordered by when it starts to hurt.

Live plans: [`knowledgelayer.md`](./knowledgelayer.md) · [`knowledgelayer-v2.md`](./knowledgelayer-v2.md)

---

## Auth

### Invite links (preferred over OAuth)

```
admin:     inventarium workspace invite acme --role member  →  https://relay/join/ONCE-abc123
teammate:  opens it, a token is minted in their browser, the link burns
```

**Why this and not GitHub OAuth.** Today an admin provisions each teammate with the CLI and
then has to *transmit a bearer token out-of-band* — Slack, 1Password, whatever. That handoff
is the weakest link in the current design, and it is the only real gap. An invite link closes
it, adds self-service onboarding, and costs no OAuth app, no client secret, no callback URL,
no `better-auth` dependency — so it still works on a self-hosted box behind a VPN or airgapped.

**When OAuth actually becomes necessary:** the §5.1 Team Cloud tier, where signup must happen
with no admin in the loop, and where identity needs to be *proven* rather than asserted by an
admin. Not before. `external_id` is already shaped as `github:<numeric id>`, so OAuth remains
an additive login flow rather than a schema change.

### Not planned yet
- SSO / SCIM — Business tier (§5.1).
- Per-project ACLs inside a workspace. Today a member sees the whole workspace.

---

## Knowledge layer

### §4.2b — LLM intent pass for `invariants` / `deliberatelyNotDone`
Both fields are hardcoded `[]`. The doc budgets one Haiku call per task (~$0.003) over the
diff + criteria + decision tickets. Deferred because **a wrong invariant is worse than a
missing one** — a downstream agent will trust it — so this needs an accuracy bar and a way to
mark low-confidence output before it ships.

### §4.2 — module briefs into Band B
`projectModuleBriefs()` is built and tested but not injected. *Which* brief applies is
task-derived, so putting one in Band B would break the byte-stable prefix that §4.4 exists to
create. Options: ship all briefs (stable but wasteful), or a Band B2 that only re-caches when
the directory changes. §J retrieval already delivers directory-specific knowledge in Band C.

### §4.3 — embeddings, vector kNN, RRF fusion
Deferred per §6: the category's own evidence is that structure beats similarity for code, and
BM25 + structural seeding covers the cases we have. Revisit when measurement shows a gap.

### §3.3 — the unfamiliar-repo benchmark
The Phase 1 adapter decision is **corpus-bound**: measured on inventarium itself, where
discovery headroom is already near zero (Grep 1, Glob 20 across 38 executions). The
discovery-tool-call delta was deliberately not reported for that reason. Re-run against one
unfamiliar 10k-file repo before quoting any number publicly.

### External code-index adapters (`codegraph`, `serena`)
Interface and bench are backend-agnostic and ready; neither tool is installed. Adding one is a
`resolveCodeIndex` registry entry plus one bench run. Only worth it if Q2 blast-radius moves
onto a hotter path — native's `whoCalls` is an unindexed text scan and is the one place an
external backend has a concrete argument.

---

## Multiplayer surface

Presence, live session join, shared steering, decision-inbox UI. These sit **on top of** the
sync protocol rather than inside it, and they are the demo. Blocked on nothing technical.

---

## Launch debt — unchanged since 2026-07-05, still risk #1

§7.1 ranks "build for months and never launch" first, and it has not moved. All four are
scripted and unrun; each needs Nish's auth, not more code:

- [ ] `bun publish` for `@inventarium/{cli,core,server}` — all four npm names still 404
- [ ] GitHub release for v1.0.0
- [ ] 10 good-first-issues
- [ ] Clean-machine E2E: `npx inventarium` verified on a non-Nish machine

The Week 10 gate — *≥2 non-Nish teams have run a real task through a shared board* — is
reachable today with admin-provisioned tokens. It does not need OAuth.
