import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../../../core/src/storage/paths.ts";

// PRD 1.8 — agent/skill library v0.
// Walks a candidate list:
//   1. project root: `.claude/agents/`      — user's per-project subagents
//   2. dev checkout: monorepo `.claude/agents/`
//   3. CLI package:  bundled `agents/`      — 6 ships-with subagents
//
// Parses YAML frontmatter (name, description, tools) from each `*.md` and
// returns the union, later paths de-duped against earlier ones by `name` so
// project overrides win.

const AGENT_CANDIDATES = [
  join(resolveProjectRoot(), ".claude", "agents"),
  join(import.meta.dir, "../../../..", ".claude", "agents"),
  join(import.meta.dir, "../../../cli/agents"),
];

interface AgentEntry {
  name: string;
  description: string;
  tools: string[];
  body: string;
  source: "project" | "monorepo" | "bundled";
  path: string;
}

function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) meta[k] = v;
  }
  return { meta, body: m[2] ?? "" };
}

function scanDir(dir: string, source: AgentEntry["source"]): AgentEntry[] {
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch { return []; }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((filename) => {
      const path = join(dir, filename);
      const md = readFileSync(path, "utf-8");
      const { meta, body } = parseFrontmatter(md);
      const name = meta["name"] ?? filename.replace(/\.md$/, "");
      const description = meta["description"] ?? "";
      const tools = (meta["tools"] ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      return { name, description, tools, body, source, path };
    });
}

function discoverAgents(): AgentEntry[] {
  const seen = new Map<string, AgentEntry>();
  const sources: AgentEntry["source"][] = ["project", "monorepo", "bundled"];
  AGENT_CANDIDATES.forEach((dir, i) => {
    for (const entry of scanDir(dir, sources[i]!)) {
      if (!seen.has(entry.name)) seen.set(entry.name, entry);
    }
  });
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export const agentsRouter = new Hono();

// List discovered subagents (project overrides bundled).
agentsRouter.get("/agents", (c) => {
  const entries = discoverAgents();
  return c.json(entries.map(({ body: _b, ...rest }) => rest));
});

// Return one agent's full body (frontmatter stripped).
agentsRouter.get("/agents/:name", (c) => {
  const { name } = c.req.param();
  const found = discoverAgents().find((a) => a.name === name);
  if (!found) return c.json({ error: "not found" }, 404);
  return c.json(found);
});
