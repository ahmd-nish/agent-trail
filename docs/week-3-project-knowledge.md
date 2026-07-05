# Week 3 — Project knowledge

**Days:** D17–D23
**Goal:** Each board accumulates a living, editable, agent-readable knowledge base. Auto-injected into every task's system prompt. Grows from completed task artifacts.
**Wow moment:** After 5 tasks, the board has a real "what we're doing and how" document — without anyone typing it. Hover a knowledge line → see which task produced it.

This is the **moat** week. Cinematic UI (Week 1) wins on first impression. Agent library (Week 2) wins on first useful run. Project knowledge wins on **retention** — the more you use agent-trail, the more it knows your project, the worse it is to switch away.

It's also the **clean separation point for the paid pivot**: solo board knowledge is free forever. Cross-workspace shared knowledge with team RAG is the paid wedge.

---

## Strategic context

CLAUDE.md is great until your project gets big enough that you forget what's in it. Cursor's `@docs` is great but ephemeral. Aider's repo map is automatic but unstructured.

What's missing in the ecosystem:
- **Versioned** (change history per knowledge entry)
- **Attributable** (which task or decision produced this knowledge?)
- **Selective** (inject only relevant sections per task, not the whole document)
- **Auto-growing** (the agent's own runs propose updates)
- **Shareable** (export as Markdown for handoffs)

Solve all five.

---

## Deliverables

| # | Deliverable | Effort | Wow factor |
|---|------------|--------|-----------|
| 1 | Schema: `knowledge_entries` table + migrations | 0.5 day | ★ |
| 2 | Knowledge editor UI (sectioned markdown + preview) | 1.5 days | ★★★ |
| 3 | Auto-inject into system prompt with token budget | 1 day | ★★★★ |
| 4 | Learning extraction from completed tasks | 1.5 days | ★★★★★ |
| 5 | Knowledge ↔ task linkage (origin attribution) | 0.5 day | ★★★ |
| 6 | Export as Markdown + import from existing CLAUDE.md | 0.5 day | ★★★ |
| 7 | Buffer + week-3 review | 1.5 days | n/a |

---

## D17 — Schema + storage

### Why entries, not a single blob

A single `boards.project_knowledge TEXT` field is simpler but blocks the auto-extraction and attribution features. Use a child table from day one.

### Migration v10

```sql
CREATE TABLE knowledge_entries (
  id              TEXT PRIMARY KEY,
  board_id        TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL DEFAULT 'local',
  section         TEXT NOT NULL,                -- 'architecture' | 'conventions' | 'glossary' | 'current-focus' | 'decisions' | 'custom'
  title           TEXT NOT NULL,                -- one-line heading
  body            TEXT NOT NULL,                -- markdown
  source          TEXT NOT NULL DEFAULT 'user', -- 'user' | 'extracted'
  source_task_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,   -- always-inject regardless of relevance
  order_index     INTEGER NOT NULL DEFAULT 0,   -- within section
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_knowledge_board_section ON knowledge_entries(board_id, section, order_index);
CREATE INDEX idx_knowledge_source_task ON knowledge_entries(source_task_id) WHERE source_task_id IS NOT NULL;
```

### Sections (initial)
- `architecture` — top-level shape, key components, data flow
- `conventions` — coding style, naming, patterns to follow
- `glossary` — domain terms specific to this project
- `current-focus` — what we're working on right now (changes weekly)
- `decisions` — non-obvious choices with rationale
- `custom` — user-defined section name (stored alongside `title`)

### Types

**`packages/core/src/types/index.ts`:**
```ts
export type KnowledgeSection = "architecture" | "conventions" | "glossary" | "current-focus" | "decisions" | "custom";

export interface KnowledgeEntry {
  id: string;
  boardId: string;
  workspaceId: string;
  section: KnowledgeSection;
  title: string;
  body: string;
  source: "user" | "extracted";
  sourceTaskId: string | null;
  pinned: boolean;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}
```

### Routes

**`packages/server/src/routes/knowledge.ts`** (new):
```
GET    /api/boards/:boardId/knowledge          → list all entries grouped by section
POST   /api/boards/:boardId/knowledge          → create
PATCH  /api/knowledge/:entryId                 → update
DELETE /api/knowledge/:entryId                 → delete
POST   /api/boards/:boardId/knowledge/reorder  → bulk reorder within a section
GET    /api/boards/:boardId/knowledge/export   → render full Markdown
POST   /api/boards/:boardId/knowledge/import   → parse pasted Markdown / CLAUDE.md into entries
```

### Acceptance
- Migration applies cleanly on empty + existing DBs
- CRUD round-trips work in `curl`
- `knowledge.test.ts` smoke tests pass

---

## D18–D19 — Knowledge editor UI

### Goal
A delightful place to write and edit project knowledge. Not a wall of markdown — a structured editor.

### New "Knowledge" tab

Replace one of the existing view-switcher entries with "Knowledge" (or add as a 4th tab — actually do that, keep Dashboard).

```
View switcher: [Kanban] [Epics] [Knowledge] [Dashboard]
```

### Layout

Split view:
- **Left rail (30%):** sections list. Each section shows entry count and pin count. Click a section → filter the editor.
- **Center (50%):** entry list within the active section. Drag-reorderable (use `@dnd-kit/sortable`). Each entry is a card: title + first 80 chars of body + source badge.
- **Right (20%):** entry detail / editor panel.

When no entry selected: right panel shows a "Create new entry" form.

### Entry editor

- Title input
- Markdown editor (use `react-codemirror` with markdown mode, or a lightweight `react-markdown-editor-lite` style component)
- Section selector (dropdown)
- Pin toggle
- "Save" or auto-save on blur
- "Delete" with confirm
- If `source === "extracted"`: show "Originated from: [task title]" link

### Section templates

When user creates a new entry, the body field is pre-filled with a section-specific stub:
- architecture: `## What\n\n## Why\n\n## Notable trade-offs`
- conventions: `**Rule:** \n\n**Why:** \n\n**Exceptions:** `
- decisions: `**Decision:** \n\n**Context:** \n\n**Alternatives considered:** \n\n**Date:** `
- etc.

### Empty state

If the board has zero knowledge entries:
- Show a big centered card: "No project knowledge yet. Start with a template:"
- 3 buttons: "Architecture", "Conventions", "Import CLAUDE.md"
- Each prefills with a useful starter

### Acceptance
- Create, edit, delete, reorder all work without page refresh
- Markdown preview renders inline (split or toggle)
- Drag-reorder persists on backend
- Section templates feel useful, not generic

---

## D20 — Auto-inject into system prompt

### Goal
Every task's system prompt includes the board's project knowledge — with a smart selection so the prompt budget isn't blown by a 50K-token document.

### Selection strategy (v0.2)

For v0.2, use a **simple heuristic**, not embeddings:
1. **Always include** all entries where `pinned = 1`
2. **Always include** all entries in the `current-focus` section
3. **Always include** all entries in the `conventions` section (small, high-leverage)
4. **Conditionally include** `architecture` if the task touches an unfamiliar area (heuristic: task.component matches an entry's title or body)
5. **Conditionally include** `decisions` if title matches `task.component` or appears in `task.description`
6. **Skip** `glossary` and `custom` for budget, OR include if budget remains

Budget: total knowledge injection ≤ 4000 tokens. Use a rough char-count proxy (1 token ≈ 4 chars). If over budget, drop in order: custom > glossary > decisions > architecture > conventions > current-focus > pinned.

Phase 2 swaps this heuristic for embeddings + retrieval.

### Implementation

**`packages/core/src/knowledge/select.ts`** (new):
```ts
export function selectKnowledgeForTask(
  task: Task,
  entries: KnowledgeEntry[],
  tokenBudget: number = 4000,
): KnowledgeEntry[];
```

**`packages/core/src/adapters/claude-code.ts` — `buildSystemPrompt`:**
- Accept optional `projectKnowledge: KnowledgeEntry[]` arg
- Format as:
  ```
  ## Project knowledge

  *This is canonical context for this project. Treat it as established truth.*

  ### Conventions
  - {entry 1 title}: {body}
  - ...

  ### Current focus
  - ...

  (Truncated to <budget> tokens — view full knowledge in the board.)
  ```

**`packages/server/src/execution-manager.ts`:**
- Before spawning, fetch the board's knowledge entries, run `selectKnowledgeForTask`, pass to adapter

### Acceptance
- A task with `conventions` knowledge entries reflects those in the system prompt
- A task with 50K tokens of knowledge gets truncated to ~4K tokens
- Truncation includes the "view full knowledge in the board" marker

---

## D21–D22 — Learning extraction from completed tasks

### Goal
After every successful task, the agent itself proposes 0–3 new knowledge entries. User accepts/rejects each.

### Flow

1. Task completes successfully (`status = completed`, post-execution artifacts captured)
2. Server fires a separate cheap Claude call with:
   ```
   Given this task and its artifacts (diff, decisions answered, text events), propose 0-3 single-sentence
   learnings that should be added to the project's knowledge base. Format as JSON:

   { "proposals": [
       { "section": "conventions", "title": "...", "body": "...", "rationale": "..." },
       ...
   ]}

   Skip if nothing surprising or non-obvious happened. Empty proposals array is valid and preferred over noise.
   ```
3. Proposals stored in a new `knowledge_proposals` table (status: pending / accepted / rejected)
4. UI surfaces them in a "Learnings from your last run" card in the task detail (review mode)
5. Per proposal: accept (creates `knowledge_entries` row with `source = "extracted"`, `source_task_id` linked) or reject

### Schema

Migration v11:
```sql
CREATE TABLE knowledge_proposals (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id   TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  board_id        TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL DEFAULT 'local',
  section         TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  rationale       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_proposals_task ON knowledge_proposals(task_id);
CREATE INDEX idx_proposals_pending ON knowledge_proposals(board_id, status) WHERE status = 'pending';
```

### Implementation

**`packages/core/src/knowledge/extract.ts`** (new):
```ts
export async function extractLearnings(opts: {
  task: Task;
  artifacts: Artifact[];
  decisions: DecisionTicket[];
}): Promise<ProposalDraft[]>;
```

Uses `runClaudePlanner` (same pattern as the existing PRD planner — Claude CLI in JSON mode). Should be cheap (~$0.001 per task).

**`packages/server/src/execution-manager.ts`** — `capturePostExecutionArtifacts`:
- After artifacts captured, fire-and-forget `extractLearnings()`. Don't block task completion on it.
- Store results as proposals.

**UI — in `ReviewMode.tsx`:**
- New section: "Proposed learnings" (shown only if there are pending proposals)
- Each proposal: title + body + section badge + rationale + Accept / Reject buttons
- Bulk "Accept all" / "Reject all" if there are multiple

### Acceptance
- Run 3 tasks of varied complexity. At least one produces non-trivial proposals.
- Accepting a proposal creates a knowledge entry with correct `source_task_id` linkage.
- Rejecting doesn't error and the proposal disappears.
- Failed extraction doesn't crash the task completion.

---

## D22 — Attribution + provenance UI

### Goal
Every knowledge entry shows where it came from.

### Implementation

In the Knowledge editor's entry detail panel:
- If `source === "extracted"` and `source_task_id` is set:
  - Show: "Originated from: [task title]" as a link
  - Click → open the originating task's review mode in a side panel or modal
- If `source === "user"`: show "Added manually on [date]"

In the entry list (center panel):
- Small icon next to entries: 🤖 (extracted) or 👤 (user-added)
- Hover tooltip: "Auto-extracted from task X on Y" or "Manually added on Y"

### Acceptance
- Every extracted entry links back to its task
- Clicking the link surfaces the original task

---

## D23 — Markdown export + CLAUDE.md import + buffer

### Export

Endpoint already added (D17). UI:
- "Export as Markdown" button on the Knowledge tab header
- Downloads `<board-slug>-knowledge.md`
- Footer line: `*Generated by agent-trail · agent-trail.dev*` (soft attribution)

Format:
```markdown
# {Board name} — Project knowledge

*Exported {date}. Generated by agent-trail.*

## Architecture

### {entry title}
{entry body}

...

## Conventions
...
```

### Import

CLAUDE.md / Markdown import:
- "Import" button → paste textarea + file upload
- Parse strategy:
  - Top-level headings (`#`, `##`) → sections (mapped to closest known section name)
  - Subheadings (`###`) → entry titles
  - Body → entry body
  - Unknown sections → `custom` with the heading as the title
- Preview before committing: show parsed entries, let user uncheck any to skip
- Bulk insert on confirm

### Acceptance
- Round-trip: export from one board, import into a new board, verify all entries present
- Existing CLAUDE.md files from agent-trail itself import meaningfully

### Buffer
Use remaining time to polish:
- Animations on entry creation / deletion
- Markdown preview rendering edge cases (code blocks, tables)
- Test extraction on more real tasks
- Update README with "Project knowledge" section

---

## Privacy + the paid-pivot boundary

**Critical decision (document in code comments):**

Solo project knowledge stays on the user's machine, in their SQLite, forever. Free.

The paid Phase 2 wedge:
- Cloud sync of knowledge across devices (same user)
- Shared workspace knowledge across team members
- RAG retrieval over the team's full knowledge corpus, including past task transcripts
- Cross-workspace patterns ("teams in your industry typically structure auth like X")

For v0.2, **do not** add:
- Cloud upload buttons
- "Sync this board" affordances
- Any code that calls out to a hosted backend

That's the line. Don't blur it. The free tier is genuinely useful standalone; the paid tier is *additive*, not a feature-gate.

---

## Risks

1. **Extraction quality.** If proposals are noisy, users will turn off the feature. Mitigation: prompt iteration on real tasks during D21–D22. Default to "0 proposals" being the right answer.
2. **Token budget blowing prompts.** A user with 100 knowledge entries might overflow. Mitigation: the selection heuristic + the 4K hard cap. Visible "truncated" marker so it's not silent.
3. **Knowledge editor too complex.** Three-pane layout is heavy. If it feels overwhelming, simplify to a single-pane sectioned scrolling view for v0.2; bring back panes in v0.3.

---

## What to cut if you slip

In order:
1. CLAUDE.md import (D23) — just exporting is enough for v0.2
2. Attribution UI polish (D22) — keep the data linkage, defer the click-through
3. Drag-reorder (D18) — entries auto-order by created_at instead
4. Cut from 6 → 3 sections: keep `architecture`, `conventions`, `decisions`. Drop `glossary`, `current-focus`, `custom`.
5. **Never cut: editor + auto-inject + at least manual learning extraction**

---

## Files touched (summary)

```
packages/core/src/storage/schema.sql              ← knowledge_entries + knowledge_proposals
packages/server/src/db.ts                         ← migrations v10, v11
packages/core/src/types/index.ts                  ← KnowledgeEntry, KnowledgeSection, ProposalDraft
packages/core/src/knowledge/                      ← new directory
packages/core/src/knowledge/select.ts
packages/core/src/knowledge/extract.ts
packages/server/src/routes/knowledge.ts           ← new
packages/server/src/index.ts                      ← register route
packages/server/src/execution-manager.ts          ← fetch knowledge before spawn, extract after
packages/core/src/adapters/claude-code.ts         ← buildSystemPrompt accepts knowledge
packages/web/src/components/Knowledge/            ← new directory
packages/web/src/components/Knowledge/KnowledgeView.tsx
packages/web/src/components/Knowledge/SectionList.tsx
packages/web/src/components/Knowledge/EntryEditor.tsx
packages/web/src/components/Knowledge/EmptyState.tsx
packages/web/src/components/Knowledge/ImportModal.tsx
packages/web/src/components/task-detail/LearningsCard.tsx ← new
packages/web/src/App.tsx                          ← Knowledge view route
packages/web/src/lib/api.ts                       ← knowledge client
```

---

## Definition of done

- [ ] Knowledge editor live with sections, CRUD, drag-reorder, pin
- [ ] Auto-inject working with 4K-token budget + visible truncation
- [ ] Learning extraction runs after every completed task; failed extraction doesn't crash anything
- [ ] At least 5 real proposals reviewed (accept or reject) on agent-trail's own board this week
- [ ] Markdown export downloads a file that round-trips back via import
- [ ] `bun test` passes; new `knowledge.test.ts` covers select + extract happy paths
- [ ] Tagged `git tag v0.2.0-week-3`
- [ ] Week-3 review doc written
