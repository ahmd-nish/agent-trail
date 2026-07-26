import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextDir } from "./store.ts";

// PRD_OPEN_SOURCE §4.4 (§D slice) — task memories.
//
// After a task completes, we persist a ~200-token summary of what changed.
// Downstream tasks in the DAG then receive these summaries in their L1
// context pack instead of full transcripts — the "strategic context per
// task" USP.
//
// The memory file is stored under `.agent-trail/context/memories/<taskId>.md`
// so it round-trips through git alongside the rest of the team context. Team
// members inherit each other's task memories on `git pull`.

const MEMORIES_DIR = "memories";
const MEMORY_TOKEN_BUDGET = 250;        // ~1000 chars — hard cap
const MEMORY_CHAR_CAP = 1200;

export interface TaskMemory {
  taskId: string;
  taskTitle: string;
  summary: string;                       // free-form, capped
  filesTouched: string[];
  decisionKeys: string[];                // labels of any decisions raised during this task
  completedAt: string;
}

export function memoriesDir(root: string): string {
  return join(contextDir(root), MEMORIES_DIR);
}

/** Ensure the memories directory exists; returns the path. */
export function ensureMemoriesDir(root: string): string {
  const dir = memoriesDir(root);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write (or overwrite) a task's memory. Returns the file path. */
export function writeTaskMemory(root: string, memory: TaskMemory): string {
  ensureMemoriesDir(root);
  const path = join(memoriesDir(root), `${memory.taskId}.md`);
  writeFileSync(path, formatMemory(memory), "utf-8");
  return path;
}

/** Read one task memory. Returns null if absent or unreadable. */
export function readTaskMemory(root: string, taskId: string): TaskMemory | null {
  const path = join(memoriesDir(root), `${taskId}.md`);
  if (!existsSync(path)) return null;
  try {
    return parseMemory(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Read every task memory sorted by completion date desc (most recent first). */
export function listTaskMemories(root: string): TaskMemory[] {
  const dir = memoriesDir(root);
  if (!existsSync(dir)) return [];
  const entries: TaskMemory[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    try {
      entries.push(parseMemory(readFileSync(join(dir, name), "utf-8")));
    } catch { /* skip malformed */ }
  }
  return entries.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
}

// ─── Heuristic summary — the MVP path, no LLM required ────────────────────────
//
// Given the task, its acceptance criteria, its git diff (from artifacts), and
// any decision tickets it raised, produce a compact narrative summary.
// This is deliberately dumb + fast — a follow-up commit will introduce a
// Haiku-generated version once the token dashboard exists to measure ROI.

export interface HeuristicSummaryInput {
  task: {
    id: string;
    title: string;
    description?: string;
    successCriteria?: string[];
  };
  gitDiff?: string;
  fileList?: string[];
  decisionKeys?: string[];
  completedAt?: string;
}

export function buildHeuristicMemory(input: HeuristicSummaryInput): TaskMemory {
  const files = uniqueFileList(input.fileList, input.gitDiff);
  const criteria = input.task.successCriteria ?? [];
  const criteriaLine = criteria.length > 0
    ? `Met criteria: ${criteria.map((c, i) => `[${i}] ${c}`).join(" · ")}`
    : "";
  const parts = [
    input.task.description?.trim() || input.task.title,
    criteriaLine,
    files.length > 0 ? `Touched: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` (+${files.length - 8} more)` : ""}` : "",
    input.decisionKeys && input.decisionKeys.length > 0
      ? `Decisions raised: ${input.decisionKeys.join(", ")}`
      : "",
  ].filter(Boolean);
  const summary = truncateAt(parts.join("\n"), MEMORY_CHAR_CAP);
  return {
    taskId: input.task.id,
    taskTitle: input.task.title,
    summary,
    filesTouched: files,
    decisionKeys: input.decisionKeys ?? [],
    completedAt: input.completedAt ?? new Date().toISOString(),
  };
}

function uniqueFileList(explicit: string[] | undefined, gitDiff: string | undefined): string[] {
  const set = new Set<string>();
  for (const f of explicit ?? []) if (f.trim()) set.add(f.trim());
  if (gitDiff) {
    // `diff --git a/foo b/bar` → `bar`. This works for staged + unstaged diffs.
    const re = /^diff --git a\/[^\s]+ b\/([^\s]+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(gitDiff)) !== null) set.add(m[1]!);
  }
  return [...set];
}

function truncateAt(text: string, cap: number): string {
  const t = text.trim();
  if (t.length <= cap) return t;
  return `${t.slice(0, cap - 20).trimEnd()}\n[…truncated]`;
}

// ─── Serialization ────────────────────────────────────────────────────────────

function formatMemory(m: TaskMemory): string {
  return [
    `# ${m.taskTitle}`,
    ``,
    `<!-- task-id: ${m.taskId} -->`,
    `<!-- completed: ${m.completedAt} -->`,
    ``,
    `## Summary`,
    ``,
    m.summary,
    ``,
    m.filesTouched.length > 0 ? `## Files touched\n\n${m.filesTouched.map((f) => `- ${f}`).join("\n")}\n` : "",
    m.decisionKeys.length > 0 ? `## Decisions raised\n\n${m.decisionKeys.map((k) => `- ${k}`).join("\n")}\n` : "",
  ].filter(Boolean).join("\n");
}

function parseMemory(text: string): TaskMemory {
  const titleMatch = text.match(/^# (.+)$/m);
  const idMatch = text.match(/<!-- task-id: (.+?) -->/);
  const completedMatch = text.match(/<!-- completed: (.+?) -->/);
  const sections = splitH2Sections(text);
  return {
    taskId: idMatch?.[1] ?? "",
    taskTitle: titleMatch?.[1] ?? "(untitled)",
    completedAt: completedMatch?.[1] ?? new Date().toISOString(),
    summary: (sections["Summary"] ?? "").trim(),
    filesTouched: parseBulletList(sections["Files touched"] ?? ""),
    decisionKeys: parseBulletList(sections["Decisions raised"] ?? ""),
  };
}

function splitH2Sections(text: string): Record<string, string> {
  // Split the markdown body on H2 headings and return a { heading: body } map.
  // Robust against multi-line bullet lists — the regex approach with lookahead
  // + /m flag had subtle boundary bugs. This is simpler and correct.
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let currentHeading: string | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (currentHeading !== null) out[currentHeading] = buf.join("\n").trim();
    buf.length = 0;
  };
  for (const line of lines) {
    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      flush();
      currentHeading = h2[1]!;
      continue;
    }
    if (currentHeading !== null) buf.push(line);
  }
  flush();
  return out;
}

function parseBulletList(section: string): string[] {
  return section
    .split("\n")
    .map((l) => l.replace(/^- /, "").trim())
    .filter((l) => l.length > 0);
}

// ─── Per-task L1 pack ─────────────────────────────────────────────────────────
//
// Builds the "strategic context per task" — instead of dumping the constitution
// + every context file into every prompt, we assemble:
//   • This task's own title/description/criteria
//   • Short summaries of each DAG dependency (from its memory file)
//
// Everything is capped so a downstream task never balloons past a fixed
// budget regardless of how many deps + how long their outputs were.

export interface PackTask {
  id: string;
  title: string;
  description?: string;
  successCriteria?: string[];
  dependsOn?: string[];
}

export interface L1Pack {
  content: string;
  bytes: number;
  sources: Array<{ kind: "self" | "dependency"; taskId: string; title: string; bytes: number }>;
  /** True when at least one dependency was truncated or dropped. */
  truncated: boolean;
}

export interface L1PackOptions {
  charCap?: number;   // total pack size cap; default ~4000 chars
  /** PRD §4.4 — up to N repo file paths ranked by term-overlap with the task.
   *  When omitted, no repo-map section is added. */
  relevantFiles?: string[];
  /** PRD §4.4b — pending user steers to merge into the pack (info the user
   *  dropped since the last iteration). Rendered as a distinct section so
   *  the agent knows this is fresh guidance, not from the plan. */
  steers?: Array<{ kind: string; text: string; createdAt?: string }>;
  /** PRD §5.2 — Ralph iteration memory. Compact "here's what previous
   *  iterations tried and why they failed" — the reader is a fresh-context
   *  spawn that has no idea what came before. */
  iterationHistory?: string;
}

export function buildL1Pack(root: string, task: PackTask, opts: L1PackOptions = {}): L1Pack {
  const cap = opts.charCap ?? 4000;
  const sources: L1Pack["sources"] = [];
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;

  // 1. This task's own scope. Always included first.
  const selfBlock = renderSelfBlock(task);
  chunks.push(selfBlock);
  used += selfBlock.length;
  sources.push({ kind: "self", taskId: task.id, title: task.title, bytes: selfBlock.length });

  // 1a. §4.4 — repo-map hint (top-N relevant paths). Cheap to include and
  // often the biggest efficiency win: the agent Reads only these instead of
  // grepping blind. Paths only, not contents — the agent decides what to load.
  if (opts.relevantFiles && opts.relevantFiles.length > 0) {
    const fileBlock = `\n=== Likely relevant files (repo map) ===\n${opts.relevantFiles.slice(0, 8).map((p) => `  • ${p}`).join("\n")}\n`;
    if (used + fileBlock.length <= cap) {
      chunks.push(fileBlock);
      used += fileBlock.length;
      sources.push({ kind: "self", taskId: task.id, title: "repo-map", bytes: fileBlock.length });
    }
  }

  // 1c. §5.2 — Ralph iteration memory. Placed BEFORE steers so the agent
  // reads the failure history first, then the new guidance. Fresh spawn +
  // this section = the "kill and re-spawn with clean context" model without
  // repeating the same fix.
  if (opts.iterationHistory && opts.iterationHistory.trim()) {
    const block = opts.iterationHistory.startsWith("\n")
      ? opts.iterationHistory
      : `\n${opts.iterationHistory}`;
    if (used + block.length <= cap) {
      chunks.push(block);
      used += block.length;
      sources.push({ kind: "self", taskId: task.id, title: "iteration-history", bytes: block.length });
    }
  }

  // 1b. §4.4b — steers the user dropped since the last iteration. Rendered
  // as a "New guidance" section so the agent knows to prefer these over
  // its own prior assumptions.
  if (opts.steers && opts.steers.length > 0) {
    const steerLines = opts.steers.map((s) => `  • [${s.kind}] ${s.text}`).join("\n");
    const steerBlock = `\n=== New guidance from the user (steering queue) ===\n${steerLines}\n`;
    if (used + steerBlock.length <= cap) {
      chunks.push(steerBlock);
      used += steerBlock.length;
      sources.push({ kind: "self", taskId: task.id, title: "steering", bytes: steerBlock.length });
    }
  }

  // 2. Dependency memories. Iterate in dependsOn order so the pack is stable.
  for (const depId of task.dependsOn ?? []) {
    if (used >= cap) { truncated = true; break; }
    const memory = readTaskMemory(root, depId);
    if (!memory) continue;
    const depBlock = renderDepBlock(memory);
    const remaining = cap - used;
    if (depBlock.length <= remaining) {
      chunks.push(depBlock);
      used += depBlock.length;
      sources.push({ kind: "dependency", taskId: depId, title: memory.taskTitle, bytes: depBlock.length });
    } else if (remaining > 200) {
      const clipped = `${depBlock.slice(0, remaining - 30).trimEnd()}\n[…truncated]\n`;
      chunks.push(clipped);
      used += clipped.length;
      sources.push({ kind: "dependency", taskId: depId, title: memory.taskTitle, bytes: clipped.length });
      truncated = true;
    } else {
      truncated = true;
    }
  }

  return {
    content: chunks.join("\n"),
    bytes: used,
    sources,
    truncated,
  };
}

function renderSelfBlock(task: PackTask): string {
  const criteria = (task.successCriteria ?? []).length > 0
    ? `\nSuccess criteria:\n${(task.successCriteria ?? []).map((c, i) => `  [${i}] ${c}`).join("\n")}`
    : "";
  return [
    `=== This task ===`,
    `Title: ${task.title}`,
    task.description?.trim() ? `Description: ${task.description.trim()}` : "",
    criteria,
  ].filter(Boolean).join("\n") + "\n";
}

function renderDepBlock(memory: TaskMemory): string {
  const files = memory.filesTouched.length > 0
    ? `\nFiles: ${memory.filesTouched.slice(0, 6).join(", ")}${memory.filesTouched.length > 6 ? " …" : ""}`
    : "";
  return [
    `\n=== Dependency: ${memory.taskTitle} ===`,
    memory.summary,
    files,
  ].filter(Boolean).join("\n") + "\n";
}

/** Rough token estimate — 1 token ≈ 4 chars for the pack size logging. */
export function tokenEstimate(chars: number): number {
  return Math.ceil(chars / 4);
}

export { MEMORY_TOKEN_BUDGET, MEMORY_CHAR_CAP };
