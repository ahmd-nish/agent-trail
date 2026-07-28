import type { Database } from "bun:sqlite";
import { list } from "./store.ts";
import type { EventType, KnowledgeEvent, Scope } from "./types.ts";

// Deterministic projections — doc §4.2.
//
// These are pure folds over the event log. They must be:
//   - regenerable — the whole projection recomputes from scratch on demand
//   - drift-free  — order comes from the log, never from a filesystem sort
//   - relevance-ranked — recency + confidence, NOT filename alphabetical
//
// This is the correctness fix for §3.1: the old loadConstitution() sorted
// context files alphabetically and hard-capped at 8K chars, which meant
// growing `decisions.md` could silently push older rulings out of the pack
// while filename order — not relevance — decided which stayed. Here the cap
// still applies but rulings are packed by recency, and every event carries
// its `supersededBy` so contradictions never appear in the same fold.

export interface FoldConstitutionOptions {
  workspaceId?: string;
  projectId?: string;
  /** Cap the total constitution length. Default matches the old loader (~2K tokens). */
  charCap?: number;
  /** Include only events at or below this scope. Default: org + project. */
  scopes?: Array<"org" | "project">;
}

export interface FoldedSection {
  type: EventType;
  entries: KnowledgeEvent[];
  truncated: boolean;
}

export interface FoldedConstitution {
  markdown: string;
  sections: FoldedSection[];
  totalChars: number;
  truncated: boolean;
}

const DEFAULT_CAP = 8000;

// Order in which sections appear inside the constitution. Rulings first
// because they outrank everything else at retrieval time (confidence
// weighting, §4.3) and because that's what the reader is scanning for.
const SECTION_ORDER: EventType[] = [
  "decision",
  "convention",
  "gotcha",
  "fix",
];

/**
 * Fold the active event log into a constitution — the L0 prompt injection
 * that every claude spawn sees. Replaces loadConstitution()'s alphabetical
 * concatenation of `.agent-trail/context/*.md` (§3.1 correctness bug).
 */
export function foldConstitution(db: Database, opts: FoldConstitutionOptions = {}): FoldedConstitution {
  const cap = opts.charCap ?? DEFAULT_CAP;
  const scopeFilter = new Set<string>(opts.scopes ?? ["org", "project"]);

  const sections: FoldedSection[] = [];
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;

  for (const type of SECTION_ORDER) {
    const events = list(db, {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      type,
      activeOnly: true,
    }).filter((e) => scopeFilter.has(scopeCategory(e.scope)));

    if (events.length === 0) continue;

    // Recency first — the log is time-sorted by id (ULID), so reverse.
    events.reverse();

    const heading = `\n\n## ${prettyType(type)}\n`;
    if (used + heading.length >= cap) { truncated = true; break; }
    chunks.push(heading);
    used += heading.length;

    const included: KnowledgeEvent[] = [];
    let sectionTruncated = false;
    for (const ev of events) {
      const block = renderEntry(ev);
      if (used + block.length > cap) {
        sectionTruncated = true;
        truncated = true;
        break;
      }
      chunks.push(block);
      used += block.length;
      included.push(ev);
    }

    sections.push({ type, entries: included, truncated: sectionTruncated });
  }

  const markdown = chunks.join("").trim();
  return { markdown, sections, totalChars: used, truncated };
}

function scopeCategory(scope: Scope): "org" | "project" | "module" | "task" {
  if (scope === "org") return "org";
  if (scope === "project") return "project";
  if (scope.startsWith("module:")) return "module";
  return "task";
}

function prettyType(t: EventType): string {
  switch (t) {
    case "decision": return "Decisions";
    case "convention": return "Conventions";
    case "gotcha": return "Gotchas";
    case "fix": return "Fixes";
    case "failed_attempt": return "Prior failed attempts";
    case "artifact_summary": return "Recent artifacts";
    case "steer": return "Recent steers";
    case "handoff": return "Handoffs";
  }
}

function renderEntry(ev: KnowledgeEvent): string {
  const date = ev.validFrom.slice(0, 10);
  const actor = ev.actorName || ev.actorId || "unknown";
  return `\n- **${date} · ${actor}** — ${ev.subject}\n${ev.body.trim().length ? `  ${ev.body.trim()}\n` : ""}`;
}
