import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { detectAuthor } from "../context/store.ts";
import { append } from "./store.ts";
import type { NewKnowledgeEvent } from "./types.ts";

// Backfill (doc §6 Weeks 1-2) — sweep the existing team-context markdown
// into the knowledge_events log so the projection has history to draw on.
// Idempotent by design: content_hash dedupe means running it twice is a
// no-op. Attribution is best-effort — filesystem markdown doesn't carry
// per-entry author, so entries fall back to the file's owner or git.

export interface BackfillReport {
  decisionsInserted: number;
  decisionsSkipped: number;
  notesInserted: number;
  notesSkipped: number;
  /** Per-task memories swept into artifact_summary events. */
  memoriesInserted: number;
  memoriesSkipped: number;
  filesRead: string[];
}

export function backfillFromContextDir(db: Database, root: string): BackfillReport {
  const rpt: BackfillReport = {
    decisionsInserted: 0, decisionsSkipped: 0,
    notesInserted: 0, notesSkipped: 0,
    memoriesInserted: 0, memoriesSkipped: 0,
    filesRead: [],
  };

  const dir = join(root, ".inventarium", "context");
  if (!existsSync(dir)) return rpt;

  const projectId = basename(root) || "local";
  const fallbackAuthor = detectAuthor(root);
  const baseCtx = { workspaceId: "local", projectId };

  // decisions.md — the highest-value source. Parse `## YYYY-MM-DD — title`
  // blocks and their **Q:** / **A:** bodies emitted by appendDecision().
  const decPath = join(dir, "decisions.md");
  if (existsSync(decPath)) {
    rpt.filesRead.push(decPath);
    for (const entry of parseDecisions(readFileSync(decPath, "utf8"))) {
      const ev: NewKnowledgeEvent = {
        ...baseCtx,
        actorKind: "human",
        actorId: entry.author ?? fallbackAuthor,
        actorName: entry.author ?? fallbackAuthor,
        taskId: null,
        executionId: null,
        type: "decision",
        scope: "project",
        subject: `${entry.taskTitle} — ${entry.question.slice(0, 120)}`,
        body: entry.answer,
        paths: [],
        confidence: "ruling",
        validFrom: entry.date ? `${entry.date}T00:00:00.000Z` : undefined,
        supersedes: null,
      };
      const { inserted } = append(db, ev);
      if (inserted) rpt.decisionsInserted++;
      else rpt.decisionsSkipped++;
    }
  }

  // Notes / conventions — each bullet line becomes a convention event.
  // We treat every `.md` in context/ except decisions.md and CLAUDE.md as
  // a convention source. Best-effort — malformed files are skipped whole.
  for (const name of readdirSync(dir).sort()) {
    if (!/\.md$/i.test(name)) continue;
    if (name === "decisions.md") continue;
    const path = join(dir, name);
    rpt.filesRead.push(path);
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch { continue; }
    for (const line of parseBullets(raw)) {
      const ev: NewKnowledgeEvent = {
        ...baseCtx,
        actorKind: "human",
        actorId: line.author ?? fallbackAuthor,
        actorName: line.author ?? fallbackAuthor,
        taskId: null,
        executionId: null,
        type: "convention",
        scope: "project",
        subject: line.text.slice(0, 120),
        body: line.text,
        paths: [],
        confidence: "ruling",
        validFrom: line.date ? `${line.date}T00:00:00.000Z` : undefined,
        supersedes: null,
      };
      const { inserted } = append(db, ev);
      if (inserted) rpt.notesInserted++;
      else rpt.notesSkipped++;
    }
  }

  // context/memories/*.md — per-task memories written by the context
  // orchestrator since long before the knowledge layer existed. On this repo
  // that is 815 files of real history the log would otherwise start without.
  //
  // They become `artifact_summary` events, which is what they are: a summary of
  // what a completed task produced. Crucially they carry the FILE FOOTPRINT, so
  // append() emits §J edges and the graph is populated rather than a list of
  // orphaned facts.
  const memDir = join(dir, "memories");
  if (existsSync(memDir)) {
    for (const file of readdirSync(memDir).filter((f) => f.endsWith(".md")).sort()) {
      const parsed = parseTaskMemory(readFileSync(join(memDir, file), "utf8"));
      if (!parsed || !isWorthKeeping(parsed)) { rpt.memoriesSkipped++; continue; }
      const { inserted } = append(db, {
        ...baseCtx,
        // Written by the executor, not a human — `observed`, never `ruling`.
        actorKind: "agent",
        actorId: "claude-code",
        actorName: "Claude Code",
        taskId: parsed.taskId,
        executionId: null,
        type: "artifact_summary",
        scope: parsed.taskId ? `task:${parsed.taskId}` : "project",
        subject: parsed.title,
        body: parsed.summary,
        paths: parsed.paths,
        confidence: "observed",
        validFrom: parsed.completedAt,
        supersedes: null,
      });
      if (inserted) rpt.memoriesInserted++; else rpt.memoriesSkipped++;
    }
    rpt.filesRead.push(memDir);
  }

  return rpt;
}

interface ParsedDecision {
  date: string | null;
  taskTitle: string;
  question: string;
  answer: string;
  author: string | null;
}

function parseDecisions(md: string): ParsedDecision[] {
  const out: ParsedDecision[] = [];
  const headerRe = /^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/gm;
  const matches: Array<{ idx: number; date: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(md)) !== null) {
    matches.push({ idx: m.index, date: m[1] ?? "", title: m[2] ?? "" });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const next = matches[i + 1];
    const block = md.slice(cur.idx, next ? next.idx : undefined);
    const q = extractLabelled(block, /\*\*Q:\*\*\s*([\s\S]*?)(?=\n\n|\*\*A:\*\*|$)/);
    const a = extractLabelled(block, /\*\*A:\*\*\s*([\s\S]*?)(?=\n_—|\n##|$)/);
    const author = extractLabelled(block, /^_—\s*(.+?)_/m);
    if (!q || !a) continue;
    out.push({
      date: cur.date || null,
      taskTitle: cur.title.trim() || "unknown task",
      question: q.trim(),
      answer: a.trim(),
      author: author?.trim() || null,
    });
  }
  return out;
}

interface ParsedNote {
  date: string | null;
  author: string | null;
  text: string;
}

function parseBullets(md: string): ParsedNote[] {
  const out: ParsedNote[] = [];
  // Match `- (2026-07-01, Nish) note text` — the format addNote() writes.
  const withMeta = /^-\s*\((\d{4}-\d{2}-\d{2}),\s*([^)]+)\)\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = withMeta.exec(md)) !== null) {
    out.push({ date: m[1] ?? null, author: (m[2] ?? "").trim() || null, text: (m[3] ?? "").trim() });
  }
  // Also match plain `- text` bullets that lack the metadata prefix.
  // We only pick those up if the with-meta pass found nothing — otherwise
  // we'd double-count on files that mix both styles.
  if (out.length === 0) {
    const plain = /^-\s+(?!\()(.+)$/gm;
    let m2: RegExpExecArray | null;
    while ((m2 = plain.exec(md)) !== null) {
      out.push({ date: null, author: null, text: (m2[1] ?? "").trim() });
    }
  }
  return out;
}

function extractLabelled(block: string, re: RegExp): string | null {
  const m = block.match(re);
  return m?.[1]?.trim() ?? null;
}

interface ParsedMemory {
  title: string;
  taskId: string | null;
  completedAt: string | undefined;
  summary: string;
  paths: string[];
}

/**
 * Parse a task-memory markdown file written by `writeTaskMemory`:
 *
 *   # <title>
 *   <!-- task-id: … -->
 *   <!-- completed: <iso> -->
 *   ## Summary
 *   …
 *   ## Files touched
 *   - path
 *
 * Returns null for a memory with no usable title or summary — a subject-less
 * event is noise in every projection that consumes it.
 */
export function parseTaskMemory(md: string): ParsedMemory | null {
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!title) return null;

  const taskId = md.match(/<!--\s*task-id:\s*([^\s>]+)\s*-->/)?.[1] ?? null;
  const completedAt = md.match(/<!--\s*completed:\s*([^\s>]+)\s*-->/)?.[1];

  const summary = md.split(/^##\s+Summary\s*$/m)[1]?.split(/^##\s+/m)[0]?.trim() ?? "";
  if (!summary) return null;

  const filesBlock = md.split(/^##\s+Files touched\s*$/m)[1]?.split(/^##\s+/m)[0] ?? "";
  const paths = [...new Set(
    filesBlock.split("\n")
      .map((l) => l.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1])
      .filter((v): v is string => !!v && !v.includes(" "))
      // A trailing-slash entry is a directory; keep it, since §J treats a
      // directory as a module and the read side expands into it.
      .map((v) => v.replace(/^`|`$/g, "")),
  )];

  return { title, taskId, completedAt, summary, paths };
}

/**
 * Is this memory worth an event?
 *
 * Measured on a real repo: 810 of 815 memories were demo/E2E scaffold whose
 * summary was literally their own title ("Task 2") with no file footprint.
 * Sweeping them in produced 815 events with 10 distinct subjects and 8 edges —
 * a log that is worse than an empty one, because FTS retrieval would surface
 * "Task 2" ahead of real knowledge and burn Band C budget on nothing.
 *
 * The rule: an event must carry information the title does not. Either a file
 * footprint (which is what makes it joinable in §J at all) or a summary that
 * says more than the heading.
 *
 * Note this is NOT caught by content-hash dedupe: `scope` is `task:<id>`, so
 * 800 identical summaries hash differently and all insert.
 */
function isWorthKeeping(m: ParsedMemory): boolean {
  if (m.paths.length > 0) return true;
  const summary = m.summary.replace(/\s+/g, " ").trim();
  const title = m.title.replace(/\s+/g, " ").trim();
  if (!summary || summary === title) return false;
  // A summary that is just the title plus a few characters is still noise.
  return summary.length > title.length + 24;
}
