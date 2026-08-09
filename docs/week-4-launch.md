# Week 4 — Templates, stats, onboarding, launch

**Days:** D24–D30
**Goal:** Ship v0.2.0. Make a stranger run their first task in under 90 seconds. Tell the world.
**Wow moment:** A new visitor lands on the README, watches the GIF, runs the install, sees the sample project demo run end-to-end, is hooked.

This week is **distribution**. Everything you've built compounds only if people try it. Treat the launch like a product, not an afterthought.

---

## Strategic context

Open-source distribution is mostly word-of-mouth via three channels:
1. **GitHub README** — what people see when a friend shares the link
2. **Hacker News** — one shot, all-or-nothing
3. **Twitter / X** — drip of demos, threads, replies

You don't get a second first impression on any of these. The week's work is making sure all three are excellent on day 30.

---

## Deliverables

| # | Deliverable | Effort | Wow factor |
|---|------------|--------|-----------|
| 1 | 5 starter templates | 1.5 days | ★★★★ |
| 2 | Onboarding flow (first-visit demo) | 1 day | ★★★★★ |
| 3 | Stats dashboard | 0.5 day | ★★★ |
| 4 | Light gamification (streaks + 3 achievements) | 0.5 day | ★★ |
| 5 | README rewrite + GIF + screenshots | 1 day | ★★★★★ |
| 6 | npm publish + GitHub release + smoke install test | 0.5 day | ★★★★ |
| 7 | HN post + Twitter thread + Discord/Reddit drops | 1 day | n/a |
| 8 | Post-launch monitoring + hot-fix readiness | 0.5 day | n/a |

---

## D24–D25 — Templates

### Goal
Pre-built boards that someone can clone with one click and immediately see something meaningful run.

### Storage

Templates live as folders under `packages/core/src/templates/`:

```
packages/core/src/templates/
  url-shortener/
    template.json        ← metadata
    prd.md               ← the PRD text
    tasks.json           ← pre-built task graph (or empty if PRD planning is expected)
    knowledge.md         ← starter project knowledge
    README.md            ← what this template builds, why it's interesting
  discord-bot/
  notion-clone/
  crud-admin/
  chrome-extension/
```

### `template.json` shape

```json
{
  "id": "url-shortener",
  "name": "URL Shortener",
  "tagline": "Build a working URL shortener in 6 tasks.",
  "estimatedMinutes": 15,
  "estimatedCost": "$0.30",
  "tags": ["fullstack", "beginner-friendly"],
  "suggestedAgents": ["test-writer", "pr-reviewer"],
  "implementationDir": "~/inventarium-runs/url-shortener"
}
```

### The 5 templates

#### 1. URL Shortener
- Stack: Hono + SQLite + Vite + React
- 6 tasks: schema, POST /shorten, GET /:code, redirect logic, simple frontend, e2e test
- Already partially exists in `examples/sample-prd.md` — adapt it

#### 2. Discord Bot
- Stack: discord.js or Bun's WebSocket client
- 5 tasks: bot scaffold, slash command handler, /weather command, /quote command, deploy guide
- Requires user to provide a bot token via `ask_human` mid-flow — great demo of HITL

#### 3. Notion-style Note App
- Stack: React + IndexedDB
- 7 tasks: schema, list view, editor with markdown, tags, search, keyboard shortcuts, export

#### 4. CRUD Admin Panel
- Stack: Bun + Hono + SQLite + a simple React table
- 5 tasks: schema for a generic resource, CRUD routes, table view, edit form, auth stub

#### 5. Chrome Extension
- Stack: Manifest V3
- 5 tasks: manifest, content script that highlights URLs, popup UI, settings sync via storage API, packaging

### Selection criteria
Each template should:
- **Build in ≤ 20 minutes** end-to-end with the planner doing the heavy lifting
- **Cost ≤ $0.50** in tokens
- **Result in something runnable** — not just code, something the user can open and use
- **Hit at least one `ask_human` moment** — shows off HITL naturally

### UI: template gallery

**Create `packages/web/src/components/TemplateGallery.tsx`:**
- Triggered from the empty-state "Try a sample" button OR from "New board → From template"
- Grid of template cards: name, tagline, tags, estimated time/cost
- Click → confirm modal with full description and what tasks will run
- Confirm → POST to `/api/templates/:id/instantiate?boardName=...` which creates a board, runs the planner if needed, populates tasks + knowledge

### New route

**`packages/server/src/routes/templates.ts`** (new):
```
GET  /api/templates              → list available templates
GET  /api/templates/:id          → template details
POST /api/templates/:id/instantiate { name, implementationDir? } → returns the new board
```

### Acceptance
- All 5 templates instantiate end-to-end without manual intervention through to "first task running"
- Each one's first task actually runs to completion in real testing
- Cost estimates are within 30% of actual

---

## D26 — Onboarding flow

### Goal
A new user lands on `localhost:5173` with zero boards and is having fun in 90 seconds.

### Flow

**Empty-state landing:**
- Big centered hero card: "Welcome to inventarium."
- 30-sec ambient video loop in the background showing the cinematic feed in action (recorded from Week 1)
- Three CTAs:
  - **"Run a sample project"** (primary, glowing) — instantiates the URL Shortener template, opens the board, immediately runs the first task
  - **"Plan from your own PRD"** — opens the PRD planner modal
  - **"Empty board"** — current behavior
- Below: small text linking to docs, GitHub, community

### "Run a sample project" flow

1. Click button
2. Brief pre-flight check: confirm `claude` is in PATH, confirm logged in (`claude --help` works)
3. If checks fail: friendly modal with the missing step + a Bash one-liner to fix
4. If checks pass: instantiate the template, open the board, kick off task 1 immediately
5. Switch view to the running task's detail (cinematic feed full-screen)
6. Subtle toast: "✨ Watch your agent build it. We'll let you know when it needs you."

### Pre-flight check route

**`packages/server/src/routes/preflight.ts`** (new):
```
GET /api/preflight → { claudeInPath: bool, claudeAuthenticated: bool, issues: string[], fixes: string[] }
```

Checks:
- `Bun.which("claude")` exists
- `claude --help` exits 0
- `~/.claude/` directory exists (auth-ish signal)

### Acceptance
- A new user with `claude` installed runs the sample with 1 click
- A new user WITHOUT `claude` gets a friendly message + one-line install command
- Total clicks from landing → watching a task run: **1**

---

## D27 — Stats dashboard + light gamification

### Stats

**Update `packages/web/src/components/DashboardView.tsx`** to be more vanity-friendly:

Top-of-page hero stats (large numbers, tabular nums):
- Tasks completed
- Total agent runtime (formatted: "12h 34m")
- Total tokens used (formatted: "1.2M")
- Total $ spent (estimate: tokens × rate from a const)
- Time saved (`tasks_completed × 30min`, prominently labeled "estimated")

Charts (lightweight, no chart lib — render with CSS or `<svg>`):
- Tasks per day over the last 30 days (bar)
- Tokens per day (line)
- ask_human count per day (small bar)

Per-board breakdown (already exists in some form):
- Tasks by status (pie or stacked bar)
- Top 5 most-used agents
- Top 5 longest-running tasks

### Streaks + achievements

**Create `packages/core/src/gamify/streaks.ts`:**
```ts
export function computeStreak(taskCompletionDates: string[]): { current: number; best: number };
```

**Achievement toasts** — fire once each:
- "First task!" on first ever completed task
- "10 tasks!" on 10th
- "First subagent delegation!" when first task with a non-empty `subagents[]` completes
- (Stretch) "First ask_human answered!"

Achievements stored in a new `user_achievements` table (single row per achievement). Don't bother with awarded date precision — just present/absent.

Migration v12:
```sql
CREATE TABLE user_achievements (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'local',
  achieved_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

Show streak in the header: "🔥 7 day streak" when current ≥ 3.

### Acceptance
- Dashboard loads in < 200ms with realistic data volumes
- All achievement triggers fire on real completion events
- Streak math is correct across timezones (use UTC dates)

---

## D28 — README + GIF + screenshots

### Goal
Anyone landing on the GitHub repo gets it in 10 seconds and is convinced in 30.

### Structure

```markdown
# inventarium

> **The fun way to run Claude Code on real projects.**
> 
> Drop a PRD, watch your agent build it.

[★ Hero GIF — 30 seconds, the wedge: PRD paste → board → run → cinematic feed → completion ding]

[![npm](badge)](url) [![License: MIT](badge)](url) [![Discord](badge)](url)

---

## What it does

- 📋 **PRD → task board** in one click
- 🎬 **Cinematic activity feed** with sound, typewriter, color
- 🤖 **6 bundled subagents** (pr-reviewer, test-writer, doc-writer, security-auditor, refactor, dep-updater)
- 📚 **Auto-growing project knowledge** — your agent's runs become your docs
- 🙋 **ask_human** — when the agent isn't sure, you decide

## 90-second start

\`\`\`bash
bun install -g inventarium
inventarium init
# → opens browser, prompts "Run a sample project?", you click yes, you watch
\`\`\`

[★ Screenshot: cinematic feed mid-run]

## How it works

[ASCII diagram — kept tight]

## What's bundled

Subagents:
- ...

Skills:
- ...

Templates:
- ...

## Project knowledge

[★ Screenshot: knowledge editor with a populated board]

A board accumulates project context as your agent runs. Each completed task proposes 0–3 single-sentence learnings; you accept or reject. The knowledge auto-injects into future task prompts.

## ask_human

[★ Screenshot: decision ticket in the feed]

When your agent hits something it shouldn't decide alone, it calls `ask_human` and pauses. You see the question on the task card, answer it, and execution resumes with your answer in context.

## CLI

\`\`\`bash
inventarium add "fix the auth bug" --board backend
inventarium run <taskId>
inventarium watch
\`\`\`

## Self-host vs cloud

inventarium is **fully self-hosted**. Your tasks, your knowledge, your tokens, your machine.

A cloud collab tier is coming (sync, team knowledge, hosted ask_human notifications). The self-hosted version stays free and full-featured forever.

## Contributing

PRs welcome. The 30-day v0.2 build log is in `docs/`.

## License

MIT
```

### GIF production

- 30 seconds max
- Tools: QuickTime → `gifski` for high-quality GIF (or `ffmpeg`)
- Subject: empty board → "Plan from PRD" → planner generates tasks → click "Run" on first task → cinematic feed shows tool calls + text → completion ding (annotate with text overlay since GIF can't carry audio)
- Bitrate: keep under 5MB. Trim cleverly.

### Screenshots (3 total)
1. Kanban board with realistic tasks, mixed statuses, dark theme
2. Cinematic feed mid-run with multiple tool cards in progress + typewriter text
3. Knowledge editor populated with realistic entries

### Acceptance
- README renders correctly on GitHub
- GIF auto-plays at acceptable bitrate
- Read top-to-bottom in 90 seconds, the project's value is unambiguous

---

## D29 — npm publish + GitHub release + install smoke test

### Pre-publish checklist

- [ ] All `vibe-board` references gone
- [ ] All workspace package versions bumped to `0.2.0`
- [ ] `package.json` `files` field correctly scoped (don't ship `node_modules`, `probe-output`, `.worktrees`, `*.db`)
- [ ] CLI binary works when installed globally (test on a fresh user account if possible)
- [ ] License headers updated where present
- [ ] CHANGELOG.md created with v0.2.0 entry summarizing the 4 pillars
- [ ] `bun publint` (or equivalent) passes
- [ ] Tagged `git tag v0.2.0` and pushed

### npm publish

Bun-specific publish:
```bash
bun publish --access public
```

(Or use `npm publish` if Bun has rough edges.)

Each subpackage published with `@inventarium/*` namespace; the CLI is the primary `inventarium` package.

### GitHub release

- Title: `v0.2.0 — Cinematic feed, bundled agents, project knowledge`
- Body: copy CHANGELOG entry + GIF + the 3 screenshots
- Attach a zipped sample run as a release asset (for archaeology)

### Smoke test (CRITICAL)

On a clean machine OR fresh user account:
1. `bun install -g inventarium` (or `npm install -g inventarium`)
2. `inventarium init`
3. Click through onboarding
4. Run a sample template
5. Watch it complete

If ANY step fails, **do not announce**. Fix and re-publish.

### Acceptance
- Package published, installable globally, runs end-to-end on a clean machine
- GitHub release page looks polished

---

## D30 — Launch day

### Order of operations

**Morning (your timezone):**
1. Final smoke test on a clean machine
2. Pre-write a "got broken on launch day" hotfix branch (be honest with yourself — something will)
3. Coffee

**HN post**
- Title: `Show HN: inventarium – a fun way to run Claude Code on real projects`
- Body (3 short paragraphs):
  1. What it is + the wedge
  2. What's interesting technically (per-task MCP scoping, TDD gate, project knowledge, bundled subagents)
  3. Self-host stance + roadmap honesty
- First comment from you within 2 minutes: link to the GIF + 90-sec quickstart
- Be present in the thread for 6 hours. Reply to every top-level comment.

**Twitter / X thread**
- 8–10 tweets
- T1: hook + GIF — "I made a fun way to watch Claude Code build things"
- T2–T8: each pillar with a screenshot or short clip
- T9: install command + GitHub link
- T10: ask for feedback, thank early users
- Quote-tweet relevant Anthropic / Claude announcements during the day for opportunistic distribution

**Other channels**
- r/ClaudeAI Reddit post (mirror of HN copy)
- Claude Code Discord (#showcase if it exists)
- IndieHackers post (skew toward the open-core story)
- Personal newsletter if you have one

### Acceptance
- HN post submitted
- Twitter thread posted
- You're available for support for the next 24 hours

---

## Post-launch (Days 30+)

### Hotfix priority
Watch for:
- Install failures on different OS/Node versions
- The `claude` CLI not being found (PATH issues are common — improve the error message)
- Migration crashes on weird-shaped legacy DBs
- Browser issues (Safari Web Audio quirks, Firefox notification quirks)

Fix anything user-reported in <24 hours. Patch release v0.2.1, v0.2.2 as needed. Don't wait for batched fixes — credibility comes from response time.

### Listen for the second wave
First wave is the launch. Second wave is people who heard about it from someone who tried it. The second wave starts day 3–5 after launch and tells you whether the product has legs.

If wave 2 is bigger than wave 1: keep going.
If wave 2 is smaller than wave 1: the wedge needs sharpening. Talk to early users. Watch screen recordings. Iterate.

---

## What to cut if you slip

In order:
1. Discord/Reddit posts on D30 (HN + Twitter is enough)
2. Achievements (streaks alone are fine)
3. Cut from 5 → 3 templates (URL Shortener + Discord Bot + CRUD Admin)
4. Stats charts (just show the hero numbers)
5. **Never cut: onboarding, README + GIF, npm publish, HN post**

The launch is the deliverable. Everything else is enabling.

---

## Risks

1. **`claude` CLI changes break stream-json parsing.** Test against the current CLI version 1 day before launch. If broken, freeze a known-good version in docs.
2. **HN flagging.** Show HN posts get flagged sometimes for arbitrary reasons. If yours gets buried, post once more 2 weeks later with a different angle. Don't spam.
3. **The "fun" doesn't land for first viewers.** Watch 3 strangers try it before launch day (record screens). If any of them look confused or bored, iterate before posting.

---

## Files touched (summary)

```
packages/core/src/templates/                        ← new
packages/core/src/templates/url-shortener/
packages/core/src/templates/discord-bot/
packages/core/src/templates/notion-clone/
packages/core/src/templates/crud-admin/
packages/core/src/templates/chrome-extension/
packages/server/src/routes/templates.ts             ← new
packages/server/src/routes/preflight.ts             ← new
packages/server/src/index.ts                        ← register routes
packages/web/src/components/TemplateGallery.tsx     ← new
packages/web/src/components/Onboarding.tsx          ← new
packages/web/src/components/DashboardView.tsx       ← rewrite hero
packages/web/src/components/StreakBadge.tsx         ← new
packages/web/src/components/AchievementToast.tsx    ← new
packages/core/src/gamify/                           ← new
packages/core/src/gamify/streaks.ts
packages/core/src/gamify/achievements.ts
README.md                                           ← rewrite
CHANGELOG.md                                        ← new
docs/screenshots/                                   ← 3 PNGs
docs/demos/launch.gif                               ← the hero GIF
```

---

## Definition of done

- [ ] 5 (or 3 if cut) templates instantiate and run end-to-end
- [ ] Onboarding takes a new visitor → running task in ≤ 90 seconds
- [ ] Stats dashboard shows realistic hero numbers
- [ ] README + GIF + 3 screenshots committed
- [ ] `inventarium` published to npm
- [ ] GitHub release published
- [ ] HN post submitted
- [ ] Twitter thread posted
- [ ] You answered every HN comment within 6 hours
- [ ] No hotfix needed in the first 6 hours (if needed, patched within 24)
- [ ] Tagged `git tag v0.2.0`
- [ ] Week-4 review doc written
- [ ] You celebrate, briefly, then start planning v0.2.1 hot-fixes based on user feedback

---

## After launch

Write `docs/v0.2.0-launch-retrospective.md`. What worked, what didn't, what surprised you, what's next.

Then take a day off before starting v0.3 planning. You've earned it.
