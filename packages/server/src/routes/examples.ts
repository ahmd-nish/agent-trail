import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../../../core/src/storage/paths.ts";

// Look for /examples in (1) the user's project root, (2) alongside the server
// package (dev checkout), (3) the CLI package's bundled examples. First match wins.
const EXAMPLES_CANDIDATES = [
  join(resolveProjectRoot(), "examples"),
  join(import.meta.dir, "examples"),
  join(import.meta.dir, "../examples"),
  join(import.meta.dir, "../../../..", "examples"),
  join(import.meta.dir, "../../../cli/examples"),
];
function examplesDir(): string | null {
  for (const p of EXAMPLES_CANDIDATES) {
    try { if (existsSync(p) && statSync(p).isDirectory()) return p; } catch { /* ignore */ }
  }
  return null;
}

export const examplesRouter = new Hono();

/**
 * List all `.md` files in /examples/ with a short preview.
 * Used by the PlanModal to offer "Browse examples".
 */
examplesRouter.get("/examples", (c) => {
  const dir = examplesDir();
  if (!dir) return c.json([]);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return c.json([]);
  }

  const items = files
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      const content = readFileSync(path, "utf-8");
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch?.[1]?.trim() ?? name.replace(/\.md$/, "");
      return {
        name,
        title,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  return c.json(items);
});

/**
 * Return the raw contents of an example PRD by filename.
 * Filename is constrained to a single segment under /examples/ to prevent traversal.
 */
examplesRouter.get("/examples/:name", (c) => {
  const { name } = c.req.param();
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(name)) {
    return c.json({ error: "Invalid filename" }, 400);
  }
  const dir = examplesDir();
  if (!dir) return c.json({ error: "Not found" }, 404);
  const path = join(dir, name);
  try {
    const content = readFileSync(path, "utf-8");
    return c.json({ name, content });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});
