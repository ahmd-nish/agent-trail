import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// PRD_OPEN_SOURCE §4.1/§4.2 — team-shared agent/skill library.
//
// Files live at `.agent-trail/library/agents/<slug>.md` (round-trips through
// git — teammates who clone the repo inherit the whole library automatically,
// same as the context store §3.2). Frontmatter is a superset of the
// agentskills.io shape so imports from the wider ecosystem work unchanged.

const LIBRARY_DIRNAME = ".agent-trail";
const LIBRARY_SUBDIR = "library";
const AGENTS_SUBDIR = "agents";

export function libraryDir(root: string): string {
  return join(root, LIBRARY_DIRNAME, LIBRARY_SUBDIR);
}
export function agentsDir(root: string): string {
  return join(libraryDir(root), AGENTS_SUBDIR);
}

export interface LibraryEntry {
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  version: string | null;
  source: string | null;         // origin URL when imported
  checksum: string | null;       // sha256 of the body, used for update-checking
  body: string;
  path: string;                  // absolute path on disk
}

// ─── Frontmatter parse ───────────────────────────────────────────────────────
// Same minimalist YAML shape as agents.ts — key: value per line, comma-lists.

export function parseAgentMarkdown(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) meta[k] = stripQuotes(v);
  }
  return { meta, body: m[2] ?? "" };
}

function stripQuotes(s: string): string {
  if ((s.startsWith(`"`) && s.endsWith(`"`)) || (s.startsWith(`'`) && s.endsWith(`'`))) {
    return s.slice(1, -1);
  }
  return s;
}

export interface ValidatedAgent {
  ok: true;
  entry: Omit<LibraryEntry, "path">;
}
export interface ValidationFailure {
  ok: false;
  error: string;
}

export function validateAgent(markdown: string, source?: string): ValidatedAgent | ValidationFailure {
  if (!markdown.trim()) return { ok: false, error: "empty markdown" };
  const { meta, body } = parseAgentMarkdown(markdown);
  const name = meta["name"]?.trim();
  const description = meta["description"]?.trim();
  if (!name) return { ok: false, error: "missing frontmatter `name`" };
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(name)) {
    return { ok: false, error: "`name` must be 1-60 chars, alphanumeric/underscore/dash only" };
  }
  if (!description) return { ok: false, error: "missing frontmatter `description`" };
  const tags = splitList(meta["tags"] ?? "");
  const tools = splitList(meta["tools"] ?? "");
  const version = meta["version"] || null;
  const checksum = sha256(body);
  return {
    ok: true,
    entry: {
      name,
      description,
      tags,
      tools,
      version,
      source: source ?? meta["source"] ?? null,
      checksum,
      body,
    },
  };
}

function splitList(csv: string): string[] {
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ─── FS helpers ──────────────────────────────────────────────────────────────

export function ensureAgentsDir(root: string): string {
  const dir = agentsDir(root);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface SaveOptions {
  /** When true, overwrite an existing entry with the same name; otherwise
   *  return an error and leave the existing file alone. */
  overwrite?: boolean;
}

export function saveAgent(
  root: string,
  entry: Omit<LibraryEntry, "path">,
  opts: SaveOptions = {},
): { ok: true; path: string } | { ok: false; error: string } {
  ensureAgentsDir(root);
  const path = join(agentsDir(root), `${entry.name}.md`);
  if (existsSync(path) && !opts.overwrite) {
    return { ok: false, error: `agent "${entry.name}" already exists — pass overwrite=true to replace` };
  }
  writeFileSync(path, renderAgentMarkdown(entry), "utf8");
  return { ok: true, path };
}

export function deleteAgent(root: string, name: string): boolean {
  const path = join(agentsDir(root), `${name}.md`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function readAgent(root: string, name: string): LibraryEntry | null {
  const path = join(agentsDir(root), `${name}.md`);
  if (!existsSync(path)) return null;
  const md = readFileSync(path, "utf8");
  const v = validateAgent(md);
  if (!v.ok) return null;
  return { ...v.entry, path };
}

export function listAgents(root: string): LibraryEntry[] {
  const dir = agentsDir(root);
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch { return []; }
  const entries: LibraryEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    try {
      const v = validateAgent(readFileSync(full, "utf8"));
      if (v.ok) entries.push({ ...v.entry, path: full });
    } catch { /* skip malformed */ }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function renderAgentMarkdown(entry: Omit<LibraryEntry, "path">): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${entry.name}`);
  lines.push(`description: ${entry.description}`);
  if (entry.tags.length > 0)   lines.push(`tags: ${entry.tags.join(", ")}`);
  if (entry.tools.length > 0)  lines.push(`tools: ${entry.tools.join(", ")}`);
  if (entry.version)           lines.push(`version: ${entry.version}`);
  if (entry.source)            lines.push(`source: ${entry.source}`);
  if (entry.checksum)          lines.push(`checksum: ${entry.checksum}`);
  lines.push("---");
  lines.push("");
  lines.push(entry.body.trim());
  lines.push("");
  return lines.join("\n");
}

// ─── Import from a URL ───────────────────────────────────────────────────────

export interface FetchOptions {
  /** Override the default fetch — used by tests to avoid real network. */
  fetchImpl?: typeof fetch;
  overwrite?: boolean;
}

export async function importAgentFromUrl(
  root: string,
  url: string,
  opts: FetchOptions = {},
): Promise<{ ok: true; entry: LibraryEntry } | { ok: false; error: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { ok: false, error: `fetch returned ${res.status}` };
  const text = await res.text();
  const v = validateAgent(text, url);
  if (!v.ok) return { ok: false, error: v.error };
  const saved = saveAgent(root, v.entry, { overwrite: opts.overwrite });
  if (!saved.ok) return { ok: false, error: saved.error };
  return { ok: true, entry: { ...v.entry, path: saved.path } };
}

// ─── Scaffold (§4.2) ────────────────────────────────────────────────────────

export function scaffoldAgent(name: string, description = "TODO: describe what this agent is good at"): Omit<LibraryEntry, "path"> {
  const safe = name.trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60);
  const body = [
    `# ${safe}`,
    "",
    "## When to use",
    "",
    "TODO: describe the situations this agent handles well.",
    "",
    "## System prompt",
    "",
    "TODO: paste the system-prompt body the agent should run with.",
  ].join("\n");
  return {
    name: safe,
    description,
    tags: [],
    tools: [],
    version: "0.1.0",
    source: null,
    checksum: sha256(body),
    body,
  };
}
