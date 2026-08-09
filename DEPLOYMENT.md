# Deploying inventarium

inventarium is designed as a **local-first, single-user** orchestrator. It spawns subprocesses (the `claude` CLI + test runners), writes to a local SQLite database, creates git worktrees, and runs an SSE-backed HTTP server. The deployment surface below reflects that reality — some cloud platforms just aren't a fit, and we call that out plainly.

Read [SECURITY.md](./SECURITY.md) first if you're deploying anywhere the machine holds credentials the agent could read.

---

## Prerequisites

| Requirement       | Version    | Notes                                                                 |
|-------------------|------------|-----------------------------------------------------------------------|
| **Bun**           | ≥ 1.1      | Primary runtime. `curl -fsSL https://bun.sh/install \| bash`          |
| **git**           | ≥ 2.30     | Per-task worktrees + `git diff` artifacts                              |
| **claude CLI**    | current    | Install from https://claude.ai/download, then `claude login`           |
| **gh CLI**        | optional   | Only needed if you turn on auto-PR (board setting `autoPr`)            |
| Node              | not needed | Bun replaces node for the whole stack                                  |

Run `inventarium doctor` — the built-in preflight — to verify all of the above before you rely on the install.

---

## Scenario 1 — Local development machine

The default. One user, one machine, everything on-disk.

```bash
# From a fresh clone
bun install
bun run -F @inventarium/web build
bun test                                # 369/369 should pass

# Launch (opens the board on port 3002)
bun packages/cli/src/index.ts
```

Data lives in the directory you launched from:

- `./inventarium.db` — SQLite (WAL mode)
- `./.inventarium/replays/` — recorded SSE streams per execution
- `./.worktrees/` — per-task git worktrees (when the executor spawns them)
- `~/inventarium-runs/` — fallback implementation dir (when a board doesn't set one)

To move the data, either `mv inventarium.db somewhere/else` and set `INVENTARIUM_DB_PATH`, or launch from a different directory.

---

## Scenario 2 — One-command install with `npx`

For giving to a collaborator or running from any directory.

```bash
# From ANY directory (published to npm as `inventarium`)
npx inventarium
```

Behind the scenes:

1. The CLI checks its own package directory for a bundled server + web `dist/`.
2. It picks an open port (3002, then 3003, then next free).
3. It spawns the server with `INVENTARIUM_ROOT = process.cwd()`.
4. Data lands in the current directory — call from a project root, not your home directory.

Add `--demo` to open the scripted replay instead (no API key needed):

```bash
npx inventarium --demo
```

Add `--no-open` to skip the browser launch (headless boot):

```bash
npx inventarium --no-open
```

---

## Scenario 3 — Docker container

Useful when you want to sandbox the agent's file access to a specific mounted volume.

```dockerfile
FROM oven/bun:1

# 1. System dependencies for git + claude CLI + gh
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y gh \
 && curl -fsSL https://claude.ai/install.sh | bash

# 2. App
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile \
 && bun run -F @inventarium/web build

# 3. Run as a non-root user
RUN useradd -m -u 1001 trail
USER trail
WORKDIR /workspace

EXPOSE 3002
ENV INVENTARIUM_PORT=3002 \
    INVENTARIUM_ROOT=/workspace \
    INVENTARIUM_SKIP_RUNNER=1

CMD ["bun", "/app/packages/cli/src/index.ts", "--no-open"]
```

Build + run:

```bash
docker build -t inventarium .
docker run --rm -it \
  -p 3002:3002 \
  -v "$(pwd):/workspace" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  inventarium
```

Open http://localhost:3002.

The `-v $(pwd):/workspace` mount is where the agent gets read+write access. Nothing outside the volume is reachable, which is the whole point.

---

## Scenario 4 — GitHub Actions / CI

Full example lives at [`docs/ci-example.yml`](./docs/ci-example.yml). Shape:

```yaml
- name: Start inventarium server
  run: |
    nohup npx inventarium --no-open > /tmp/at.log 2>&1 &
    for _ in {1..30}; do curl -sf http://localhost:3002/api/health && break || sleep 1; done

- name: Run task headless
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: inventarium run --task ${{ inputs.task_id }} --ci --timeout 1500 | tee "$GITHUB_STEP_SUMMARY"
```

Exit codes from `inventarium run --ci`:

| Code | Meaning                                              |
|------|------------------------------------------------------|
| 0    | Task completed (green)                               |
| 1    | Task failed                                          |
| 2    | Task landed `awaiting_human` — human input needed    |
| 124  | Poll timeout (raise `--timeout <seconds>`)           |

---

## Scenario 5 — Long-running server on a VPS (small team)

If you want a shared board on a Linode / DigitalOcean / Fly.io box.

```bash
# systemd unit: /etc/systemd/system/inventarium.service
[Unit]
Description=inventarium
After=network.target

[Service]
Type=simple
User=trail
WorkingDirectory=/srv/inventarium
Environment=INVENTARIUM_PORT=3002
Environment=INVENTARIUM_ROOT=/srv/inventarium
Environment=INVENTARIUM_SKIP_RUNNER=0
Environment=ANTHROPIC_API_KEY=REDACTED
ExecStart=/usr/local/bin/bun packages/cli/src/index.ts --no-open
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

Put a reverse proxy in front:

```nginx
server {
  listen 443 ssl http2;
  server_name trail.example.com;
  ssl_certificate     /etc/letsencrypt/live/trail.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/trail.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;

    # SSE — the whole point of the /stream endpoint.
    proxy_buffering    off;
    proxy_cache        off;
    proxy_read_timeout 3600s;

    proxy_set_header  Host              $host;
    proxy_set_header  X-Real-IP         $remote_addr;
    proxy_set_header  X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header  X-Forwarded-Proto $scheme;
    proxy_set_header  Connection        "";
  }
}
```

**Auth is your responsibility.** inventarium v1 does not ship SSO / RBAC — put it behind Cloudflare Access, an OAuth proxy (oauth2-proxy), or a Tailscale ACL.

---

## What inventarium is NOT designed for

- **Serverless / edge (Vercel, Cloudflare Workers, Deno Deploy)** — the executor spawns long-lived subprocesses, opens SSE streams, writes to SQLite, and creates git worktrees. None of that survives a request-response model.
- **Read-only filesystem containers** — the agent needs write access to the working directory, the DB, and `.inventarium/`. If your platform forbids writes, inventarium won't work.
- **Multi-tenant SaaS** — v1 assumes a single trusted user per install. Cloud SaaS with per-user isolation is on the paid roadmap ([PRD_PAID.md](./PRD_PAID.md) — internal); OSS stays local-first.
- **Windows without WSL** — untested. Use WSL 2 or a Linux VM.

---

## Environment variables

| Variable                    | Default              | Purpose                                                                 |
|-----------------------------|----------------------|-------------------------------------------------------------------------|
| `INVENTARIUM_PORT`          | `3002`               | HTTP server port                                                        |
| `INVENTARIUM_ROOT`          | CWD                  | Where DB, worktrees, `.inventarium/` live                                |
| `INVENTARIUM_DB_PATH`       | `<root>/inventarium.db` | Override the SQLite location outright                                |
| `INVENTARIUM_URL`           | `http://localhost:3002` | Client-side base URL (for the CLI)                                    |
| `INVENTARIUM_RUNNER_URL`    | `http://localhost:3003` | Dev-server manager URL (Phase 2 runner package)                       |
| `INVENTARIUM_SKIP_RUNNER`   | unset                | `=1` to skip auto-spawning the dev-server runner                        |
| `ANTHROPIC_API_KEY`         | unset                | Optional — the `claude` CLI uses its own auth if logged in              |

Legacy env vars (`AGENT_TRAIL_DB_PATH`, `AGENT_TRAIL_URL`, `AGENT_TRAIL_RUNNER_URL`) are honored with a deprecation warning for one release. Migrate before v0.3.

Mock env vars used ONLY in tests — set them and the app runs without a real claude CLI, but the "runs" produce no real work:

- `INVENTARIUM_PLANNER_MOCK` — JSON or `file:<path>`
- `INVENTARIUM_CLAUDE_MOCK` — JSON scenario for the adapter
- `INVENTARIUM_CASE_GEN_MOCK` — JSON for the test-case generator

---

## Ports

| Port | Service                             | Configurable                       |
|------|-------------------------------------|------------------------------------|
| 3002 | Main HTTP server (SSE + static SPA) | `INVENTARIUM_PORT`                 |
| 3003 | Dev-server runner (managed dev)     | `INVENTARIUM_RUNNER_URL` + package  |
| 5173 | Vite dev server                     | Only in `bun run dev` — not needed for a deployed build |

---

## Persistence + backups

Everything is either a file in your project directory or a row in `inventarium.db`. Backup strategy:

```bash
# Full snapshot — safe to run while inventarium is stopped
tar czf inventarium-backup-$(date +%F).tar.gz \
    inventarium.db \
    .inventarium/ \
    .worktrees/
```

If inventarium is running, use SQLite's `.backup` command instead of copying the file directly (WAL mode makes a plain `cp` unsafe):

```bash
sqlite3 inventarium.db ".backup 'inventarium.db.snapshot'"
```

Retention:

- **Replay recordings** — `.inventarium/replays/*.jsonl` grow with usage. Prune old ones via the API:

  ```bash
  curl -X POST http://localhost:3002/api/tasks/<taskId>/test-runs/prune \
       -H 'Content-Type: application/json' \
       -d '{"retentionDays": 90}'
  ```

- **Test run history** — same endpoint; defaults to 90 days.

---

## Updating

```bash
# Pull, install, rebuild, restart
git pull --ff-only
bun install
bun run -F @inventarium/web build
sudo systemctl restart inventarium   # or however you started it
```

Migrations run automatically on boot — see `packages/server/src/db.ts` `MIGRATIONS[]`. There's no rollback path; take a `.backup` before upgrading a production install.

---

## Troubleshooting

| Symptom                                       | Likely cause + fix                                                     |
|-----------------------------------------------|------------------------------------------------------------------------|
| Server dies on boot, "SQLITE_CANTOPEN"        | `INVENTARIUM_DB_PATH` points to a directory the user can't write to    |
| Task stuck on `in_progress` after a restart   | Crash recovery couldn't reach the DB — check permissions. See v1-bug-5 |
| SSE stream drops every ~60s                   | Reverse proxy has a short `proxy_read_timeout` — raise it (see nginx block above) |
| `inventarium doctor` says claude CLI missing  | Install from https://claude.ai/download, then `claude login`           |
| Every run says `Cannot reach server`          | Port 3002 in use — either kill the old process or export `INVENTARIUM_PORT` |
| Cost odometer stays at $0.00                  | Task hasn't produced any usage yet, or the executions row is empty     |
| Auto-PR reports "detached HEAD"               | The board's implementation dir isn't on a branch; run `git checkout -b <name>` first |

For anything else, `bun run start` and check the logs — the server writes to stdout, and `.inventarium/replays/<execId>.jsonl` has the exact SSE trace of a specific run.

---

## Getting help

- Bug or unexpected behavior → [open an issue](https://github.com/ahmd-nish/inventarium/issues/new/choose)
- Security concern → email per [SECURITY.md](./SECURITY.md), not a public issue
- Feature idea → [feature-request issue template](./.github/ISSUE_TEMPLATE/feature_request.md)
