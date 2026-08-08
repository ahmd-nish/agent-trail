// knowledgelayer §4.2 — the two projections that were still unbuilt, plus the
// Obsidian export.
//
// Projections are deterministic FOLDS, never authored. That is the property
// that makes the log trustworthy as an audit trail: a projection cannot drift
// from history, because it has no state of its own to drift with.
//
// These two belong in **Band B** of the three-band prompt (§4.4) — written
// once per project, byte-identical across every task in a board run, and read
// at 0.10x behind a cache breakpoint. Regenerating them per query would spend
// the exact tokens the band structure exists to save.

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleUrn, toPosixPath } from "./code-index.ts";
import { list } from "./store.ts";
import type { KnowledgeEvent } from "./types.ts";

export interface ProjectionOptions {
  workspaceId?: string;
  projectId?: string;
}

// ── Module briefs ────────────────────────────────────────────────────────────

export interface ModuleBrief {
  /** Directory this brief covers. */
  module: string;
  /** Events scoped to it, most recent first. */
  facts: KnowledgeEvent[];
  markdown: string;
}

/**
 * One brief per directory that has accumulated knowledge. A fact lands in a
 * brief when its `scope` is `module:<dir>` OR when its paths sit under that
 * directory.
 *
 * Only directories with at least `minFacts` are emitted — a brief holding one
 * incidental fact is noise, and the point of Band B is a stable, worthwhile
 * prefix rather than a wall of near-empty files.
 */
export function projectModuleBriefs(
  db: Database,
  opts: ProjectionOptions & { minFacts?: number; maxFactsPerModule?: number } = {},
): ModuleBrief[] {
  const minFacts = opts.minFacts ?? 2;
  const maxFacts = opts.maxFactsPerModule ?? 15;
  const events = list(db, {
    workspaceId: opts.workspaceId,
    projectId: opts.projectId,
    activeOnly: true,
  });

  const byModule = new Map<string, KnowledgeEvent[]>();
  const push = (mod: string, e: KnowledgeEvent) => {
    if (!mod) return;
    const bucket = byModule.get(mod) ?? [];
    if (!bucket.some((x) => x.id === e.id)) bucket.push(e);
    byModule.set(mod, bucket);
  };

  for (const e of events) {
    if (e.scope.startsWith("module:")) push(e.scope.slice(7), e);
    for (const p of e.paths) {
      const parts = toPosixPath(p).split("/");
      // Attribute to the immediate parent directory only. Walking every
      // ancestor would file the same fact under `packages`, which is too
      // coarse to be a brief about anything.
      if (parts.length > 1) push(parts.slice(0, -1).join("/"), e);
    }
  }

  const briefs: ModuleBrief[] = [];
  for (const [module, facts] of [...byModule.entries()].sort()) {
    if (facts.length < minFacts) continue;
    const ordered = [...facts].sort((a, b) => b.validFrom.localeCompare(a.validFrom)).slice(0, maxFacts);
    const lines: string[] = [`# ${module}`, ""];
    const rulings = ordered.filter((e) => e.confidence === "ruling");
    const rest = ordered.filter((e) => e.confidence !== "ruling");
    if (rulings.length) {
      lines.push("## Rulings", "");
      for (const e of rulings) lines.push(`- **${e.subject}** — ${e.actorName}, ${e.validFrom.slice(0, 10)}`);
      lines.push("");
    }
    if (rest.length) {
      lines.push("## Observed", "");
      for (const e of rest) lines.push(`- ${e.subject} _(${e.type}, ${e.validFrom.slice(0, 10)})_`);
      lines.push("");
    }
    briefs.push({ module, facts: ordered, markdown: lines.join("\n").trimEnd() + "\n" });
  }
  return briefs;
}

// ── PROJECT_MAP ──────────────────────────────────────────────────────────────

export interface ProjectMap {
  root: string;
  stack: string[];
  entrypoints: string[];
  topDirs: Array<{ dir: string; files: number }>;
  markdown: string;
}

/**
 * Detected stack + structure. Derived from the filesystem, not from the event
 * log — it answers "what IS this repo", which no amount of decision history
 * can tell you.
 */
export function projectProjectMap(root: string, opts: { maxDirs?: number } = {}): ProjectMap {
  const files = trackedFiles(root);
  const stack = detectStack(root, files);

  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    const top = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join("/") : ".";
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const topDirs = [...counts.entries()]
    .map(([dir, n]) => ({ dir, files: n }))
    .sort((a, b) => b.files - a.files)
    .slice(0, opts.maxDirs ?? 12);

  const entrypoints = files.filter((f) =>
    /(^|\/)(index|main|cli|server|app)\.(m?[tj]sx?)$/.test(f),
  ).slice(0, 12);

  const lines: string[] = ["# PROJECT_MAP", ""];
  if (stack.length) lines.push(`**Stack:** ${stack.join(" · ")}`, "");
  if (topDirs.length) {
    lines.push("**Layout:**", "");
    for (const d of topDirs) lines.push(`- \`${d.dir}\` — ${d.files} file${d.files === 1 ? "" : "s"}`);
    lines.push("");
  }
  if (entrypoints.length) {
    lines.push("**Entrypoints:**", "");
    for (const e of entrypoints) lines.push(`- \`${e}\``);
    lines.push("");
  }

  return { root, stack, entrypoints, topDirs, markdown: lines.join("\n").trimEnd() + "\n" };
}

function detectStack(root: string, files: string[]): string[] {
  const stack: string[] = [];
  const has = (p: string) => files.includes(p) || existsSync(join(root, p));
  let pkg: Record<string, unknown> = {};
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch { /* not node */ }
  const deps = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };

  if (has("bun.lock") || has("bunfig.toml")) stack.push("Bun");
  else if (has("pnpm-lock.yaml")) stack.push("pnpm");
  else if (has("package-lock.json")) stack.push("npm");
  if (has("tsconfig.json")) stack.push("TypeScript");
  if (has("go.mod")) stack.push("Go");
  if (has("Cargo.toml")) stack.push("Rust");
  if (has("pyproject.toml") || has("requirements.txt")) stack.push("Python");

  for (const [dep, label] of [
    ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["next", "Next.js"],
    ["hono", "Hono"], ["express", "Express"], ["fastify", "Fastify"],
    ["vite", "Vite"], ["tailwindcss", "Tailwind"], ["drizzle-orm", "Drizzle"],
  ] as const) {
    if (deps[dep]) stack.push(label);
  }
  return stack;
}

function trackedFiles(root: string): string[] {
  try {
    const res = spawnSync("git", ["-C", root, "ls-files"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
    });
    if (res.status !== 0) return [];
    return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Obsidian vault ───────────────────────────────────────────────────────────

export interface VaultNote {
  /** Relative path inside the vault. */
  path: string;
  markdown: string;
}

/**
 * An EXPORT PROJECTION, not a store.
 *
 * Obsidian offers no retrieval scoring, no temporal validity, no attribution
 * and no multi-writer merge — the four properties §4.1 exists to provide. So
 * the log stays the source of truth and this is a fold beside
 * `projectConstitutionMd` / `projectAgentsMd`: one note per active event, with
 * frontmatter and `[[wikilinks]]` along the module axis, so the graph is
 * browsable by humans and readable by any MCP-connected agent.
 */
export function projectObsidianVault(db: Database, opts: ProjectionOptions = {}): VaultNote[] {
  const events = list(db, {
    workspaceId: opts.workspaceId,
    projectId: opts.projectId,
    activeOnly: true,
  });
  const notes: VaultNote[] = [];
  const moduleIndex = new Map<string, string[]>();

  for (const e of events) {
    const slug = noteSlug(e);
    const modules = [...new Set(
      e.paths
        .map((p) => toPosixPath(p).split("/").slice(0, -1).join("/"))
        .filter(Boolean),
    )];
    for (const m of modules) {
      moduleIndex.set(m, [...(moduleIndex.get(m) ?? []), slug]);
    }

    const fm = [
      "---",
      `id: ${e.id}`,
      `type: ${e.type}`,
      `scope: ${e.scope}`,
      `confidence: ${e.confidence}`,
      `actor: ${yamlString(e.actorName)}`,
      `valid_from: ${e.validFrom}`,
      e.taskId ? `task: ${e.taskId}` : null,
      e.paths.length ? `paths:\n${e.paths.map((p) => `  - ${p}`).join("\n")}` : null,
      "---",
    ].filter(Boolean).join("\n");

    const body = [
      `# ${e.subject}`,
      "",
      e.body.trim(),
      "",
      modules.length ? `**Applies to:** ${modules.map((m) => `[[${m}]]`).join(" · ")}` : "",
    ].filter(Boolean).join("\n");

    notes.push({ path: `events/${slug}.md`, markdown: `${fm}\n\n${body}\n` });
  }

  for (const [module, slugs] of [...moduleIndex.entries()].sort()) {
    const lines = [
      "---", `type: module`, `module: ${module}`, "---", "",
      `# ${module}`, "",
      ...[...new Set(slugs)].sort().map((s) => `- [[${s}]]`),
    ];
    notes.push({ path: `modules/${module.replace(/\//g, "-")}.md`, markdown: lines.join("\n") + "\n" });
  }

  return notes;
}

function noteSlug(e: KnowledgeEvent): string {
  const base = e.subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "event";
  // ULID suffix keeps two same-titled events from colliding on disk.
  return `${base}-${e.id.slice(-6)}`;
}

function yamlString(s: string): string {
  return /[:#\-{}[\]]/.test(s) ? JSON.stringify(s) : s;
}

export { moduleUrn };
