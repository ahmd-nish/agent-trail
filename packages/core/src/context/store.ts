import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { resolveStateDir } from "../storage/paths.ts";

// PRD_OPEN_SOURCE Phase 3 — team-context layer.
// The `.inventarium/context/` directory is the team's shared brain: every
// answered decision ticket auto-appends here (§3.3); users add conventions
// and architectural rulings via `inventarium context add` (§3.2); the whole
// pile is injected as an L0 "constitution" into every claude execution (§3.4).

const CONTEXT_SUBDIR = "context";
const DECISIONS_FILE = "decisions.md";
const DEFAULT_NOTES_FILE = "notes.md";

// L0 constitution cap. ~2K tokens ≈ ~8K chars — the PRD's suggested ceiling.
// A hard cap keeps the constitution from becoming a token sink as the team's
// decision log grows over time.
const CONSTITUTION_CHAR_CAP = 8000;

export function contextDir(root: string): string {
  // Via resolveStateDir, not a hardcoded name, so a pre-rename `.agent-trail/`
  // directory is migrated rather than silently orphaned. Hardcoding the
  // current name here is exactly how a rename loses a user's context store:
  // the code keeps working, against an empty directory.
  return join(resolveStateDir(root), CONTEXT_SUBDIR);
}

export function ensureContextDir(root: string): string {
  const dir = contextDir(root);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface DecisionEntry {
  taskTitle: string;
  question: string;
  answer: string;
  author?: string;
  /** Override for tests; production uses new Date(). */
  now?: Date;
}

export function appendDecision(root: string, entry: DecisionEntry): string {
  ensureContextDir(root);
  const path = join(contextDir(root), DECISIONS_FILE);
  const date = (entry.now ?? new Date()).toISOString().slice(0, 10);
  const author = entry.author ?? detectAuthor(root);
  const block = formatDecisionBlock({ ...entry, author, date });

  // Seed the file with a heading so future readers (and the constitution loader)
  // know what they're looking at.
  const isNew = !existsSync(path);
  if (isNew) {
    appendFileSync(
      path,
      "# Decisions\n\nAuto-appended by inventarium every time a decision ticket is answered.\nEach entry is a durable ruling any future agent execution will see.\n\n",
      "utf8",
    );
  }
  appendFileSync(path, block, "utf8");
  return path;
}

function formatDecisionBlock(args: {
  taskTitle: string;
  question: string;
  answer: string;
  author: string;
  date: string;
}): string {
  const { taskTitle, question, answer, author, date } = args;
  return [
    `## ${date} — ${taskTitle}`,
    "",
    `**Q:** ${question.trim()}`,
    "",
    `**A:** ${answer.trim()}`,
    "",
    `_— ${author}_`,
    "",
    "",
  ].join("\n");
}

export interface AddNoteOptions {
  text: string;
  author?: string;
  /** Override the default `notes.md` — useful for topical files like
   *  `conventions.md`, `architecture.md`, etc. */
  file?: string;
  now?: Date;
}

export function addNote(root: string, opts: AddNoteOptions): string {
  ensureContextDir(root);
  const filename = sanitizeFilename(opts.file ?? DEFAULT_NOTES_FILE);
  const path = join(contextDir(root), filename);
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const author = opts.author ?? detectAuthor(root);

  const isNew = !existsSync(path);
  const header = isNew ? `# ${prettyTitle(filename)}\n\n` : "";
  const body = `- (${date}, ${author}) ${opts.text.trim()}\n`;
  appendFileSync(path, header + body, "utf8");
  return path;
}

function sanitizeFilename(input: string): string {
  // Only allow simple markdown filenames — no path traversal, no absolute paths.
  const stripped = input.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "");
  const withExt = /\.mdx?$/i.test(stripped) ? stripped : `${stripped}.md`;
  if (withExt === "" || withExt === ".md") return DEFAULT_NOTES_FILE;
  return withExt;
}

function prettyTitle(filename: string): string {
  const stem = filename.replace(/\.mdx?$/i, "").replace(/[-_]+/g, " ").trim();
  if (!stem) return "Notes";
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

export interface ConstitutionSource {
  path: string;
  chars: number;
  truncated: boolean;
}

export interface Constitution {
  content: string;
  sources: ConstitutionSource[];
  truncated: boolean;
}

export interface LoadConstitutionOptions {
  /** Override the default 8K-char cap (useful for tests). */
  charCap?: number;
}

/**
 * L0 constitution (§3.4) — read CLAUDE.md at the project root plus every
 * markdown file in `.inventarium/context/`, concatenated with source-of-truth
 * headers. Hard-capped at ~8K chars (~2K tokens); files past the cap are
 * omitted with a truncation marker on the last-included source.
 */
export function loadConstitution(root: string, opts: LoadConstitutionOptions = {}): Constitution {
  const cap = opts.charCap ?? CONSTITUTION_CHAR_CAP;
  const sources: ConstitutionSource[] = [];
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;

  const consider = (path: string, label: string) => {
    if (used >= cap) { truncated = true; return; }
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, "utf8");
      if (!raw.trim()) return;
      const header = `\n\n=== ${label} ===\n\n`;
      const suffix = `\n\n[…truncated — see ${label} for full content]`;
      const remaining = cap - used - header.length;
      if (remaining <= 0) { truncated = true; return; }
      let body: string;
      let wasTruncated = false;
      if (raw.length > remaining) {
        // Reserve room for the truncation marker so the whole chunk fits under the cap.
        const bodyBudget = Math.max(0, remaining - suffix.length);
        body = `${raw.slice(0, bodyBudget).trimEnd()}${suffix}`;
        wasTruncated = true;
      } else {
        body = raw;
      }
      chunks.push(header + body);
      used += header.length + body.length;
      sources.push({ path, chars: body.length, truncated: wasTruncated });
      if (wasTruncated) truncated = true;
    } catch {
      // Skip unreadable files silently — context is best-effort.
    }
  };

  consider(join(root, "CLAUDE.md"), "CLAUDE.md");

  const dir = contextDir(root);
  if (existsSync(dir)) {
    try {
      const entries = readdirSync(dir)
        .filter((f) => /\.mdx?$/i.test(f))
        .sort();
      for (const name of entries) {
        const full = join(dir, name);
        try {
          if (!statSync(full).isFile()) continue;
        } catch {
          continue;
        }
        consider(full, `.inventarium/context/${name}`);
      }
    } catch {
      // Directory listing failed — treat as no context files.
    }
  }

  return { content: chunks.join("").trim(), sources, truncated };
}

/**
 * Best-effort author for decision entries: git config user.name → hostname →
 * literal "local". Never throws; the point is auto-attribution, not identity
 * enforcement.
 */
export function detectAuthor(root: string): string {
  try {
    const name = execSync("git config user.name", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).toString().trim();
    if (name) return name;
  } catch {
    // git not configured or not a repo — fall through
  }
  try {
    const h = hostname();
    if (h) return h;
  } catch {
    // fall through
  }
  return "local";
}
