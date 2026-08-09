# Week 2 — Bundled agent + skill library

**Days:** D10–D16
**Goal:** Ship a curated library of 6 reusable subagents and 4 skills. Discoverable, assignable per task, prompt-injected at execution time.
**Wow moment:** User creates a task, picks the bundled `pr-reviewer` subagent from a dropdown, hits Run. Watches Claude delegate to the subagent, gets a structured review back, tweets it.

This is the **leverage** week. Every solo CLI agent user has built their own ad-hoc subagents in `.claude/agents/` — and complained about it. Ship a great default library and they'll ditch the ad-hoc ones.

---

## Strategic context

The existing v0.1 schema already has `task.subagents[]` and `task.skills[]`. Per the original handoff doc: *"MCPs enforced at spawn time via --mcp-config; skills strongly suggested in system prompt (Claude Code can't be forced to fire a skill from outside — be honest about this in docs)."*

This week makes both real:
- **Discoverable** — scan user's local `.claude/`, bundled library, and a board-level `.claude/`
- **Assignable** — UI picker in task create/edit
- **Injected** — append "you have access to these subagents: X, Y, Z" to the system prompt + (where possible) hint the agent to delegate

The honesty principle: we don't pretend to *force* skill/subagent invocation. We make it more likely by:
- Naming them clearly in the system prompt
- Describing when each is appropriate
- Optionally injecting a "first action should be to evaluate delegation to one of: …" line for high-confidence cases

---

## Deliverables

| # | Deliverable | Effort | Wow factor |
|---|------------|--------|-----------|
| 1 | Agent discovery (filesystem scanner + cache) | 1 day | ★★ |
| 2 | 6 bundled reusable subagents | 2 days | ★★★★★ |
| 3 | Skill discovery + 4 bundled skills | 1 day | ★★★ |
| 4 | Task create/edit UI: agent + skill picker | 1 day | ★★★★ |
| 5 | System prompt injection + execution wiring | 0.5 day | ★★★ |
| 6 | Agent detail modal + "view source" + community gallery stub | 0.5 day | ★★★ |
| 7 | Buffer day | 1 day | n/a |

---

## D10 — Agent discovery infrastructure

### Goal
A single function returns all subagents available to a board, regardless of source.

### Data sources (in priority order)
1. **Board-scoped:** `<implementation_dir>/.claude/agents/*.md`
2. **User-scoped:** `~/.claude/agents/*.md`
3. **Bundled:** `packages/core/src/agents/library/*.md`

Higher priority wins on name collision. Log conflicts.

### Files

**Create `packages/core/src/agents/discovery.ts`:**
```ts
export interface AgentDef {
  name: string;
  description: string;
  source: "board" | "user" | "bundled";
  sourcePath: string;
  tools?: string[];      // from frontmatter
  model?: string;        // from frontmatter
  body: string;          // markdown body (system prompt)
  tags?: string[];       // for filtering: review, test, docs, etc.
}

export async function discoverAgents(opts: { implementationDir?: string }): Promise<AgentDef[]>;
```

- Reads `.md` files, parses YAML frontmatter, extracts body
- Caches by `(mtime, path)` — re-reads on disk change
- Returns deduplicated list

**Create `packages/core/src/agents/types.ts`** — shared types.

### Schema additions

Migration v9:
```sql
-- No new tables yet. The discovery is filesystem-driven for v0.2.
-- Reserved for future: an `agents` table for cloud-synced custom agents in Phase 2.
```

Reuse the existing `task.subagents[]` column. Each entry stores the agent name; discovery resolves it at execution time.

### Acceptance
- Running `discoverAgents()` returns ≥6 bundled agents on a fresh install
- Adding a `.md` to `~/.claude/agents/` makes it appear without restart (mtime cache invalidation works)
- Name collisions resolve to the highest-priority source, with a console log

---

## D11–D12 — Ship 6 bundled subagents

### Library structure

```
packages/core/src/agents/library/
  pr-reviewer.md
  test-writer.md
  doc-writer.md
  security-auditor.md
  refactor-pass.md
  dep-updater.md
  README.md          ← explains the format + how to contribute
```

### Subagent format

Each file:
```markdown
---
name: pr-reviewer
description: Reviews uncommitted changes for risks, test coverage gaps, and style issues. Use after a task completes.
model: claude-sonnet-4-6
tools: [Bash, Read, Grep, Glob]
tags: [review, quality]
---

You are a senior code reviewer. Given the changes in this working directory:

1. Run `git diff HEAD` to see what changed.
2. For each meaningful change, evaluate:
   - Correctness: does the code do what the task asked?
   - Tests: are there tests covering the change? Run them.
   - Risk: what could break? What's the blast radius?
   - Style: matches surrounding code?

Output a structured review:

## Summary
<2-3 sentences on the overall change>

## Strengths
- ...

## Concerns
| Severity | Location | Issue | Suggested fix |
|----------|----------|-------|---------------|
| ... | ... | ... | ... |

## Test coverage
- Files changed: N
- Files with new/updated tests: N
- Coverage gap: <list any untested logic>

## Verdict
APPROVE | APPROVE WITH NITS | REQUEST CHANGES
```

### The 6 agents

#### 1. `pr-reviewer`
Reviews uncommitted changes. As above. Tags: `review, quality`.

#### 2. `test-writer`
- **Input:** target file or function
- **Behavior:** Reads the target, identifies testable seams, writes 5–10 focused tests using the project's test framework, runs them
- **Output:** new/updated `*.test.ts` (or framework equivalent), test run summary
- **Tags:** `test, quality`

#### 3. `doc-writer`
- **Behavior:** Scans changed files since last commit. For each module without a top-of-file doc comment, generates one. Updates README if public API surface changed.
- **Output:** modified files + a "doc changes" summary
- **Tags:** `docs, quality`

#### 4. `security-auditor`
- **Behavior:** Greps for OWASP top-10 patterns (eval, raw SQL, unescaped HTML, hardcoded secrets, missing CSRF, weak crypto). Runs `npm audit` / `pip-audit` if available. Checks for `.env` leaks in commits.
- **Output:** severity-tagged findings, suggested remediations
- **Tags:** `security, quality`

#### 5. `refactor-pass`
- **Behavior:** Identifies duplication, dead code, overly-long functions. Proposes 1–3 refactors with diffs. Asks `ask_human` before applying anything ≥50 LOC.
- **Output:** applied refactors + report
- **Tags:** `refactor, quality`

#### 6. `dep-updater`
- **Behavior:** Detects package manager. Runs the right `outdated` command. For each safe update (patch, minor), bumps + re-runs tests. For majors, stops and asks `ask_human` with a changelog link.
- **Output:** lockfile changes + report
- **Tags:** `deps, maintenance`

### The bar
Before shipping each:
- Run it on 3 real repos (yours, inventarium itself, one open-source project of your choice)
- The output must be something you'd use in your own workflow
- If it's not, fix the prompt or cut the agent

A mediocre `pr-reviewer.md` is worse than no `pr-reviewer.md`. Set the bar high.

### Acceptance
- Each agent runs end-to-end on inventarium itself without erroring
- Each produces a meaningfully useful output (judged by you)
- Each is under 80 lines of markdown

---

## D13 — Skill discovery + 4 bundled skills

### Format
Same as agents but in `~/.claude/skills/` and `packages/core/src/agents/library-skills/`. Skills are simpler — usually a single named action with trigger conditions.

### 4 bundled skills

#### 1. `add-test`
- **Trigger:** user says "add test for X" or after creating a new function
- **Behavior:** Find the right test file, add a focused test, run it

#### 2. `extract-component`
- **Trigger:** "extract this into a component"
- **Behavior:** Pull a JSX block into a new file, wire props, update import sites

#### 3. `migrate-to-typescript`
- **Trigger:** "convert this .js to .ts"
- **Behavior:** Rename, add types (use `any` only at boundaries), update imports, run tsc

#### 4. `add-error-handling`
- **Trigger:** "this needs error handling"
- **Behavior:** Wrap risky calls in try/catch, surface errors to the right boundary, add user-facing message if UI

### Discovery

**`packages/core/src/agents/discovery.ts` (extended)**:
```ts
export interface SkillDef { /* same shape as AgentDef */ }
export async function discoverSkills(opts): Promise<SkillDef[]>;
```

### Acceptance
- All 4 skills present in the picker after install
- Each runs on a real example

---

## D14 — Task UI: agent + skill picker

### Goal
In the task create/edit modal, two new fields: "Subagents" and "Skills". Multi-select with search.

### Files

**Update `packages/web/src/components/task-detail/MetadataPanel.tsx`** or create `packages/web/src/components/task-detail/AgentPicker.tsx`:

- Two collapsible sections: "Suggested subagents" and "Suggested skills"
- Each shows a multi-select combobox with fuzzy search
- Each row in the dropdown:
  - Name (mono font)
  - Description (single line, truncated)
  - Source badge (Bundled / Yours / Board)
  - "View" button → opens a modal showing the source `.md`
- Selecting writes to `task.subagents[]` / `task.skills[]`

### New API routes

**`packages/server/src/routes/agents.ts`** (new):
```
GET /api/agents          → list available agents (across all sources)
GET /api/agents/:name    → get one agent's full definition
GET /api/skills          → same for skills
GET /api/skills/:name    → same
```

Pass `implementationDir` as a query param so board-scoped agents are picked up.

### API client

**`packages/web/src/lib/api.ts`:**
```ts
agents: {
  list: (implementationDir?: string) => req<AgentDef[]>(`/api/agents?dir=${implementationDir ?? ""}`),
  get: (name: string) => req<AgentDef>(`/api/agents/${name}`),
},
skills: { ... },
```

### Acceptance
- Picker shows all bundled agents on a fresh install
- Adding a `.md` to `~/.claude/agents/` reflects in the picker on next open (no page refresh needed if cache invalidation works)
- "View" opens the source file in a syntax-highlighted modal

---

## D15 — System prompt injection + execution wiring

### Goal
When a task with assigned subagents/skills runs, the agent KNOWS about them.

### Files

**`packages/core/src/adapters/claude-code.ts` — `buildSystemPrompt`:**
- Extend to include sections:
  - `## Available specialized subagents` (list each with description; agent decides when to delegate via the `Task` tool)
  - `## Available skills` (list each with trigger conditions; agent decides when to invoke)
- If task has ≥1 strongly-recommended subagent (configurable per-task), add: `## Recommended first step` with delegation hint

**Subagent resolution:**
- The execution manager looks up each `task.subagents[i]` name via `discoverAgents()` for that board
- Writes the resolved bodies into a temp directory and passes via `--agents-dir` (if Claude Code supports it) OR just inlines the descriptions into the system prompt (always works)

For v0.2, **inline into system prompt**. Cleaner, no CLI flag dependency, always works.

### Prompt template addition
```
You have access to these specialized subagents — delegate to them via the `Task` tool when appropriate:

- **pr-reviewer**: Reviews uncommitted changes for risks, test coverage gaps, and style issues.
- **test-writer**: Generates focused tests for a target file or function.
...

You have access to these skills (trigger them when their description matches the work):

- **add-test**: when adding a new function or behavior
...
```

### Acceptance
- A task with `subagents: ["pr-reviewer"]` produces a stream where the agent calls `Task(subagent_type: "pr-reviewer", ...)` at least once when reviewing is the right move
- A task with no assigned subagents produces a stream where the agent doesn't try to delegate
- Adding a subagent doesn't break the existing happy-path tests

---

## D16 — Agent detail modal + gallery stub + buffer

### Agent detail modal
- Clicking "View" on a picker row opens a centered modal
- Renders the `.md` source with syntax highlighting (use `shiki` or `highlight.js`)
- Shows source badge, last modified, file path
- "Edit" button only enabled for non-bundled (user/board) sources — opens the file in user's default editor via a `file://` link or a copy-path button

### Gallery stub
**Create `packages/web/src/components/AgentGallery.tsx`** (linked from Settings):
- Lists all available agents grouped by source
- Per-row: name, description, tags, "use in next task" quick-action
- Future: "Browse community gallery" button linking to a GitHub repo or website (placeholder URL for v0.2; real gallery is Phase 2)

### Buffer day
Use D16 to:
- Fix anything from D10–D15 that's rough
- Polish agent picker UX (animations, empty states)
- Test each bundled agent one more time
- Update README with the agent library section

### Acceptance
- Gallery shows all agents, organized
- Each can be quick-applied to a new task

---

## Risk: the bundled agents themselves

The biggest risk this week is **quality of the bundled agents**. The infrastructure is straightforward; the prompts are not.

Mitigation:
- Spend at least half of D11–D12 on prompt iteration, not just file creation
- Get one external person to try each agent on their own project (a friend, a Discord, X)
- If an agent doesn't pass the "would I use this daily" bar, **don't ship it**. 4 great agents > 6 mediocre ones.

---

## What to cut if you slip

In order:
1. Gallery view (D16) — agents are still usable from the task picker
2. Agent detail modal (D16) — show source as a link instead
3. Skill bundling (D13) — agents alone are the bigger wedge
4. Cut from 6 → 4 bundled agents: drop `dep-updater` and `refactor-pass` (highest-risk prompts)
5. **Never cut: pr-reviewer, test-writer, doc-writer, security-auditor**

---

## Files touched (summary)

```
packages/core/src/agents/                       ← new directory
packages/core/src/agents/discovery.ts
packages/core/src/agents/types.ts
packages/core/src/agents/library/               ← 6 .md files + README
packages/core/src/agents/library-skills/        ← 4 .md files
packages/server/src/routes/agents.ts            ← new
packages/server/src/routes/skills.ts            ← new
packages/server/src/index.ts                    ← register routes
packages/core/src/adapters/claude-code.ts       ← extend buildSystemPrompt
packages/server/src/execution-manager.ts        ← resolve agents before spawn
packages/web/src/components/task-detail/AgentPicker.tsx ← new
packages/web/src/components/task-detail/MetadataPanel.tsx ← wire picker
packages/web/src/components/AgentDetailModal.tsx ← new
packages/web/src/components/AgentGallery.tsx     ← new
packages/web/src/lib/api.ts                      ← agents/skills client
```

---

## Definition of done

- [ ] `discoverAgents()` returns 6 bundled agents on a fresh install
- [ ] 4 bundled skills similarly discoverable
- [ ] Task creation UI has working agent + skill pickers with fuzzy search
- [ ] Assigned subagents appear in the system prompt
- [ ] All 6 agents tested on inventarium itself + 1 external repo each
- [ ] At least one task in the inventarium repo uses one of the bundled agents to do real work this week (dogfood)
- [ ] `bun test` passes
- [ ] Tagged `git tag v0.2.0-week-2`
- [ ] Week-2 review doc written
