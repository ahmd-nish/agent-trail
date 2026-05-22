# agent-trail — Context Handoff

> **Purpose of this document:** Transfer the full state of the agent-trail project to a new session (Cowork, fresh Claude chat, or human handoff) without losing decisions, rationale, or momentum. Read this top-to-bottom before touching code.

---

## 1. What we're building

**agent-trail** is an open-source, MIT-licensed, lightweight kanban board for orchestrating Claude Code (and eventually other AI agents) on real software projects.

**The pitch in one sentence:** Drop a PRD, get a task graph, assign MCPs/skills/sub-agents per task, watch Claude Code execute under a TDD gate with live telemetry, get pinged when the agent needs a human decision.

**Codename:** `agent-trail` (working name — locked for now, may rename after Day 7 once the tool is real and a better name is obvious).

**Why the name:** Agents leave a *trail* of telemetry, artifacts, and decisions you can follow. Picked from a user-suggested shortlist after five rounds of naming that ate too much time; chosen because it was the only option in that shortlist without obvious npm/GitHub/trademark conflicts.

---

## 2. Why this exists (the six gaps)

The user evaluated existing tools — Flux (sirsjg/flux), claude-task-viewer (L1AD), Claw-Kanban, eyalzh/kanban-mcp, langwatch/kanban-code, dzikrihilman/kanban-mcp — and concluded that the closest competitor (Flux) leaves **six concrete gaps** that agent-trail must close:

| # | Gap in Flux | How agent-trail closes it |
|---|---|---|
| 1 | No agent assignment field | `Task.assignee` enum: claude-code / codex / gemini / custom. Adapter pattern dispatches to the right runner. |
| 2 | No MCP/Skill binding (free text only) | Structured fields: `Task.mcps[]`, `Task.skills[]`, `Task.subagents[]`. Auto-discovered from `.claude/` and `.mcp.json`. **MCPs enforced at spawn time** via `--mcp-config`; skills strongly suggested in system prompt (Claude Code can't be forced to fire a skill from outside — be honest about this in docs). |
| 3 | No execution telemetry | Wrap every agent spawn. Parse `--output-format stream-json`. Capture tool calls, tokens, duration, errors into `executions` + `telemetry_events` tables. |
| 4 | No live "what's happening now" view | SSE channel per task. Stream-json events render as live activity on the card. Denormalized into `Task.activeForm` for fast UI reads. |
| 5 | No result/artifact capture | Post-execution hook: git diff, test output, modified files list, optional PR URL. Auto-attached to task via `artifacts` table. |
| 6 | No multi-agent orchestration | Adapter interface. MVP ships Claude Code only; Codex/Gemini land in v0.2. The seam is in place from day one so adding adapters doesn't require schema or core changes. |

**Plus features no competitor has:**
- PRD ingestion → structured task graph (via Anthropic API, not Claude Code — see decision #4 below)
- DAG-based sequential vs parallel detection
- TDD gate: write_tests → implement → verify_tests, can't close until tests pass
- Human decision tickets via built-in `ask_human` MCP tool — agent pauses, user answers on the card, agent resumes

---

## 3. Architecture decisions (locked)

### 3.1 Stack
- **Runtime:** Bun 1.x (fast startup, native SQLite, native test runner, fits TDD)
- **Language:** TypeScript everywhere
- **Backend framework:** Hono (tiny, fast, SSE-native)
- **Storage:** SQLite via `bun:sqlite`, with JSON export option for portability
- **Frontend:** React 18 + Vite + Tailwind + shadcn/ui + @dnd-kit
- **Planner SDK:** `@anthropic-ai/sdk`
- **Agent execution:** `node:child_process` spawning the `claude` CLI in headless mode
- **MCP:** `@modelcontextprotocol/sdk` (TypeScript)
- **Lint/format:** Biome (one tool, fast)
- **Tests:** `bun:test`

**Why Bun + TS over FastAPI + Python (the user's other stack):**
1. Claude Code CLI is Node-native — spawning it from Node has zero friction
2. MCP TypeScript SDK is best-in-class
3. Keeps a future VS Code extension path open (same language both sides)
4. Keeps this codebase distinct from the user's Python projects (Classifi.ai), avoiding context switching

### 3.2 Execution split (key decision)
**Anthropic API** handles: PRD parsing, task graph generation, sub-task decomposition, parallel/sequential detection, mid-task consults, PR description generation. Pure reasoning, no filesystem needed, fast, cheap.

**Claude Code (headless)** handles: code editing, file ops, running tests, fixing test failures. Anything that needs the tools and the repo on disk.

This split is non-negotiable. It's what makes the planner cheap (API call ≈ pennies) and the executor competent (Claude Code with real tools and full repo context).

### 3.3 Storage: SQLite + JSON export
SQLite (via `bun:sqlite`) is the source of truth. WAL mode. Single migration file for MVP. JSON export so users can pin tasks to git or move between machines.

### 3.4 Concurrency model
- Each parallel task runs in its **own git worktree** to prevent merge conflicts
- Each task gets a **scoped MCP config** (`--mcp-config <temp-path>`) so MCPs are per-task, not global
- MVP caps parallelism at **3 concurrent tasks** to keep the dev experience sane

### 3.5 TDD gate (three-phase task model)
Default task lifecycle:
1. `write_tests` — agent writes failing tests
2. `implement` — agent writes code to make tests pass
3. `verify_tests` — tests run; must pass to close the task

Non-TDD tasks (e.g., docs, config) use a single `implement_only` phase. The `Task.tddEnabled` boolean toggles this.

### 3.6 Human decision flow
When the agent calls the built-in `ask_human` MCP tool:
1. The tool writes a row to `decision_tickets` and returns a sentinel response telling the agent to stop
2. Task status → `blocked` (substatus: awaiting_human)
3. Execution status → `awaiting_human`
4. UI surfaces the question on the card with an input field
5. User answers → `decision_tickets.answer` populated → dispatcher re-spawns the task with the answer in context

Default behaviour is **pause and wait**. Config knob exists for "best-guess and flag for review" but defaults off.

---

## 4. MVP scope (locked, 7-day target)

### In scope
- [x] **Day 1 — DONE:** Monorepo scaffold, MIT license, README, strict tsconfig, Biome, core domain types, SQLite schema, Claude Code stream-json **probe script**, sample PRD
- [ ] **Day 2:** Anthropic SDK + planner (PRD → `Task[]` via tool-use structured output), DAG resolver (topological sort + parallel groups), planner tests with fixture PRD (stub the SDK in tests)
- [ ] **Day 3:** Board UI — 6-column kanban (Backlog/Ready/In Progress/Blocked/In Review/Done), task detail panel, DAG visualization with react-flow, MCP/skill assignment UI, auto-discovery of `.claude/` and `.mcp.json`
- [ ] **Day 4:** Worktree manager, MCP config injection per task, Claude Code adapter, stream-json parser (locked against probe output), SSE stream to frontend, telemetry capture
- [ ] **Day 5:** Three-phase TDD flow, test runner integration (auto-detect jest/pytest/bun:test), `ask_human` MCP tool, UI for answering decision tickets
- [ ] **Day 6:** Post-execution hooks (diff, test output, file list), MCP server exposing the board to Claude Code itself, JSON export
- [ ] **Day 7:** E2E test with sample PRD, error handling, README with screenshots, demo video, publish to npm as v0.1.0

### Explicitly out of scope for MVP
- Codex / Gemini adapters (v0.2)
- VS Code extension wrapper (v0.2)
- Multi-user / auth (never for v1)
- Cloud sync (never)
- Webhooks (v0.3)
- Mobile / push notifications (never)

---

## 5. Risks acknowledged

These were flagged before Day 1 started; the user signed off on proceeding anyway.

1. **Claude Code `--output-format stream-json` schema is the linchpin.** The probe script (Day 1) de-risks this by capturing real output before Day 4 builds the parser.
2. **MCP config injection per task** is non-trivial. We chose the temp config file + `--mcp-config` path approach, paired with per-task git worktrees so the working directory carries `.mcp.json` scope cleanly.
3. **Skills can't be forced from outside.** Claude Code reads skills from `.claude/skills/` and loads them at its discretion. We can only suggest strongly in the system prompt. Documented as a known limitation: "MCPs are enforced, skills are suggested."
4. **TDD greenfield edge case** — if tests don't exist yet, the three-phase model handles it (write_tests phase comes first).
5. **One-week timeline is tight but realistic** if no surprises. If the probe reveals stream-json is different from expected, Day 7 slips. That's fine and expected — we'd rather discover this on Day 1 than Day 4.
6. **Open source maintenance reality** — the user accepts that a working tool will attract issues and PRs that take real time.

---

## 6. State of the code (end of Day 1)

### Where it lives
- **Repo target on user's Mac:** `/Users/nish/Documents/startitup/agent-trail`
- **Source of truth (where Claude built it):** files attached to the previous chat message in the source conversation
- **17 files total, no `node_modules`**

### Directory structure
```
agent-trail/
├── .gitignore
├── LICENSE                                       # MIT
├── README.md                                     # positioning, install, roadmap
├── biome.json
├── package.json                                  # root, Bun workspaces
├── tsconfig.json                                 # strict TS
├── docs/
│   └── day-01.md                                 # completion log + Day 2 plan
├── examples/
│   └── sample-prd.md                             # URL shortener PRD for Day 7 dogfood
├── packages/
│   ├── cli/package.json                          # stub
│   ├── core/
│   │   ├── package.json                          # @agent-trail/core
│   │   └── src/
│   │       ├── index.ts                          # re-exports
│   │       ├── storage/
│   │       │   └── schema.sql                    # full SQLite schema
│   │       └── types/
│   │           └── index.ts                      # Task, Execution, TelemetryEvent, etc.
│   ├── mcp-server/package.json                   # stub
│   ├── server/package.json                       # stub
│   └── web/package.json                          # stub
└── scripts/
    └── probe-claude-code.ts                      # the de-risking probe
```

### What's actually implemented
- **Types:** complete and locked. `Task`, `Board`, `Execution`, `Artifact`, `TelemetryEvent`, `DecisionTicket`, plus enums (`TaskStatus`, `Priority`, `AgentKind`, `TddPhase`).
- **Schema:** complete and locked. Tables: `boards`, `tasks`, `executions`, `artifacts`, `telemetry_events`, `decision_tickets`. WAL, foreign keys, the indexes needed for fast UI reads.
- **Probe script:** complete. Four scenarios (simple text, single tool call, multi-step, expected failure). Writes `probe-output/<timestamp>/{raw.jsonl, summary.json, report.md}`. **Has not yet been run** — the user needs to run it on their Mac with `claude` CLI installed.

### What's *not* implemented yet
Everything else. Days 2–7.

---

## 7. The single biggest pending action

**Run the probe script.** Until we see real `claude -p ... --output-format stream-json` output, the Day 4 parser is hypothetical. Command (from the repo root, on the user's Mac, with `claude` CLI installed and authenticated):

```bash
bun scripts/probe-claude-code.ts
```

Output appears in `probe-output/<timestamp>/`. The file to share back is `report.md` — that locks the TypeScript event types for the parser.

Cost: ~$0.10 in API usage.

---

## 8. Open conversation threads / pending decisions

These are real questions that haven't been settled:

1. **Anthropic model for the planner.** Default plan: `claude-sonnet-4-6` for cost/quality balance. Confirm with a real PRD run before committing on Day 2.
2. **Structured output strategy.** Two options: JSON schema vs tool-use. Lean toward tool-use (more reliable). Decide on Day 2.
3. **Planner repair-loop budget.** If schema validation fails, retry how many times before failing the planner step? Proposing 2.
4. **Final project name.** `agent-trail` is the codename. Day 7 is the natural moment to decide if it stays or changes. Renaming an unpublished npm package costs ~1 hour. Don't agonize.
5. **Whether to set up GitHub repo now or after MVP.** Recommended: now, push every day. Lets the world see momentum and lets the user revert if a day goes sideways.

---

## 9. User context (relevant to handoff)

- **Developer:** Nish, Mac-based dev environment, comfortable with TypeScript, FastAPI, React, full-stack work.
- **Active projects:** Classifi.ai (FastAPI + React/TS trade compliance platform with multi-agent architecture). Familiar with PydanticAI, Descope, atomic design, service-layer architecture, SSE, MCP integration.
- **Preferences known:** Modular codebases, atomic design on frontend, service-layer separation on backend, clean architecture, no unnecessary documentation during implementation, direct file deliverables. **TDD-leaning.**
- **Working style:** Tends to prefer clarifying questions answered with tappable options. Will sometimes paste old messages back as a way of re-anchoring the conversation. Doesn't always read long messages carefully on first pass — keep lists tight and lead with the action.

---

## 10. How to resume in Cowork

If this is being read by a fresh Claude session via Cowork:

1. **Read this whole document first.** No shortcuts.
2. **Look at the 17 files in `/Users/nish/Documents/startitup/agent-trail`.** Read at minimum: `packages/core/src/types/index.ts`, `packages/core/src/storage/schema.sql`, `scripts/probe-claude-code.ts`, `docs/day-01.md`, `examples/sample-prd.md`.
3. **Ask Nish for the probe report** if it hasn't been run yet. Without it, Day 2 is the only safe forward move (the planner doesn't depend on probe output).
4. **Start Day 2** following the plan in `docs/day-01.md` "Day 2 plan" section. First file to create: `packages/core/src/planner/index.ts`. First test: fixture PRD → expected task graph.
5. **Keep `docs/day-NN.md` going.** Every day gets a completion log with rationale and the next day's plan. This is what makes the project resumable.

### Things NOT to redo
- Don't relitigate the name. It's `agent-trail` until Day 7.
- Don't relitigate stack choices. Bun + TS + Hono + SQLite is locked.
- Don't relitigate the six gaps or the MVP scope. All locked.
- Don't propose Flux integration instead of building this. The whole point is the six gaps Flux has.

### Things you SHOULD do
- Push back on Nish if a request would expand MVP scope. Time-box ruthlessly.
- Run the probe before writing the Day 4 parser. Non-negotiable.
- Keep using `ask_user_input_v0` with 2-4 tappable options for ambiguous choices — it matches how Nish works best.
- Be honest about uncertainty. Nish appreciates calibrated confidence over false certainty.

---

## 11. Appendix — full reference list

External tools/projects referenced and evaluated during planning:
- Flux (sirsjg/flux) — closest competitor, identified as having the six gaps
- claude-task-viewer (L1AD/claude-task-viewer) — view-only, watches `~/.claude/tasks/`
- Claw-Kanban (GreenSheep01201/Claw-Kanban) — multi-agent CLI routing, partial overlap
- eyalzh/kanban-mcp — pure MCP server, minimal
- langwatch/kanban-code — heavy native macOS app with tmux + worktrees
- dzikrihilman/kanban-mcp — Next.js + Drizzle, full kanban with MCP
- Raman369AI/agent-kanban-pm — local-first Python, alpha

These shaped the design but agent-trail builds from scratch — none of them solved the full problem.

---

*End of handoff. If you make it this far and something is unclear, the right move is to ask Nish before guessing.*
