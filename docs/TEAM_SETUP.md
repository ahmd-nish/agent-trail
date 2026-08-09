# Running agent-trail for a team

Everything in agent-trail works on one machine with no setup. This guide is for the part that
doesn't: **sharing what your agents learn between people.**

The promise: Sarah's agent fails a particular way on `src/auth.ts`. Tomorrow your agent picks up
a task touching that file and is told about it *before* it starts — without Sarah writing
anything down, and without a git push.

---

## 0. What actually syncs

Only the **asserted** half — decisions, gotchas, failed attempts, contracts, and the edges tying
them to code. Roughly 1KB per event; 10k events is about 10MB.

The **derived** half — symbols, call edges, the code index — is never sent. It rebuilds locally in
milliseconds and would be hundreds of megabytes on the wire. Each machine builds its own.

That split is why sync is a cursor rather than a sync engine, and why there is no CRDT here: an
append-only log with immutable ids converges by construction.

---

## 1. Run a relay

The relay is the same binary as the board. There is no separate build.

```bash
# on a box your team can reach
git clone https://github.com/ahmd-nish/agent-trail && cd agent-trail
bun install
AGENT_TRAIL_PORT=3002 AGENT_TRAIL_DB_PATH=/var/lib/agent-trail/relay.db \
  bun packages/server/src/index.ts
```

The relay endpoints are inert until credentials exist, so a fresh instance cannot be written to by
accident:

```
POST /v1/events                       append (dedupes on content hash)
GET  /v1/events?since=<ulid>          tail, returns the next cursor
GET  /v1/events/stream?since=<ulid>   SSE live tail
```

Put it behind TLS. Tokens are bearer credentials and this speaks plain HTTP on its own.

---

## 2. Create a workspace and add people

Run these **on the relay host** — membership lives in the relay's database.

```bash
export AGENT_TRAIL_DB_PATH=/var/lib/agent-trail/relay.db

bun cli workspace create acme "Acme Inc"

# Use a STABLE external id. `github:<numeric id>` is right; a GitHub *login* is
# renameable and would silently re-point a membership at a different person.
bun cli workspace member add acme github:12345 Sarah --role member
bun cli workspace member add acme github:67890 Raj   --role viewer

bun cli workspace ls
```

### Roles

| Role | Can |
|---|---|
| `viewer` | read the team's knowledge |
| `member` | read + contribute knowledge |
| `admin` | the above + manage members |
| `owner` | the above |

A viewer is genuinely useful: a contractor or a new hire can inherit everything the team knows
without being able to inject rulings into it.

---

## 3. Issue a token per person

```bash
bun cli workspace token create acme github:12345 --label "sarah-laptop" --ttl-days 90
```

It prints the token **once**. Only a hash is stored, so it cannot be shown again — reissue if lost.

A token is scoped to exactly one workspace, and the server derives scope **from the credential**.
A client cannot ask for a different workspace: the request body and query string are not trusted
for that, by construction.

```bash
bun cli workspace token ls acme
bun cli workspace token revoke <tokenId>
```

Removing someone revokes their tokens for that workspace immediately — not at the next expiry:

```bash
bun cli workspace member rm acme <userId>
```

---

## 4. Each teammate syncs

On each person's machine, in their repo:

```bash
bun cli knowledge sync \
  --remote https://relay.acme.dev \
  --workspace acme \
  --project my-repo \
  --token at_...
```

Or set it once and forget:

```bash
export AGENT_TRAIL_RELAY_URL=https://relay.acme.dev
export AGENT_TRAIL_RELAY_TOKEN=at_...
bun cli knowledge sync --workspace acme --project my-repo
```

Push then pull, one round trip. Offline is not an error state — the cursor doesn't advance, so the
next successful run sends exactly what this one couldn't. Append-only means there is never a
conflict to resolve. If a backlog remains, the CLI says so; run it again.

> **`--project` matters.** Events are stamped with your repo's directory name. If sync reports
> `pushed 0` against a non-empty log, it prints the workspace/project pairs your log actually
> contains — pass `--local-project` to match.

Run it from a cron job, a git hook, or by hand. There is no daemon.

---

## 5. Verify it worked

On the *receiving* machine:

```bash
bun cli knowledge ls           # do you see your teammate's events, with their name on them?
bun cli knowledge bench        # cross-actor governance rate > 0 means knowledge is being USED
```

The number that matters is **cross-actor governance rate**: the fraction of tasks whose context
included a fact authored by someone else *and* attached to a file the task actually modified.
Facts merely being present is vanity; this measures relevance.

Then open the board's **`graph`** tab. If teammates' events are there, joined to your files, the
loop is closed.

---

## Keeping data in

Some repos should never leave the building.

```bash
bun cli knowledge sync --local-only    # reads nothing, sends nothing
```

That flag is checked before the log is read at all, so a local-only project cannot leak through a
bug further down the code path.

Secrets are redacted at write time — before anything touches disk — so they are not in the local
log either, whether or not you ever sync.

---

## Single-workspace shortcut

For one team and one relay you can skip per-user tokens:

```bash
AGENT_TRAIL_RELAY_TOKEN=some-long-secret \
AGENT_TRAIL_RELAY_WORKSPACE=acme \
  bun packages/server/src/index.ts
```

That secret is pinned to the one workspace and grants `member` — never `admin`. A secret sitting in
an env var can carry data; it can never grant a stranger access or change who is on the team.

Fine for a trusted team on a private network. Use real tokens as soon as more than a couple of
people are involved: a shared secret has no identity, so revoking one person means rotating for
everyone.

---

## Troubleshooting

**`401 unauthorized`** — token revoked, expired, or the member was removed. Membership is re-checked
on every request. Reissue with `workspace token create`.

**`403`** — the credential is valid but the role is too low. A `viewer` gets this on write.

**`503 relay has no credentials configured`** — the relay has no tokens and no bootstrap secret.
This is the safe default, not a bug.

**`pushed 0` on a non-empty log** — the local workspace/project doesn't match what you asked for.
The CLI prints what your log actually holds; pass `--local-project`.

**Events arrive but nothing shows in the graph** — check `knowledge_edges` exists in your database.
The CLI creates it on first `knowledge` command; a database from an older build may predate it.

---

## What this does not do yet

- **No self-service signup.** An admin provisions each person. Invite links are the planned fix —
  see [`docs/backlog.md`](./backlog.md) for why that beats OAuth for self-hosting.
- **No presence or live session join.** The sync protocol is done; that UI is not.
- **No per-project ACLs.** A member sees the whole workspace.
- **SSE live tail polls** (1s) rather than using Postgres `LISTEN/NOTIFY` — correct for SQLite, and
  the thing to revisit if the relay moves to Postgres.
