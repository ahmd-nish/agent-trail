import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

// Single source of truth for the SQLite filename. Pre-v0.2 used `vibe-board.db`;
// the rename to `agent-trail.db` is handled at file level in `migrateDbFilename`
// below so existing installs keep their data without a manual move.
export const DB_FILENAME = "agent-trail.db";
const LEGACY_DB_FILENAME = "vibe-board.db";

// The project root — where the user's DB, .worktrees/, and .mcp.json live.
// For `npx agent-trail` this is the user's CWD; for local dev it's overridden
// via AGENT_TRAIL_ROOT so worktrees stay next to the source tree.
export function resolveProjectRoot(): string {
  const override = process.env["AGENT_TRAIL_ROOT"];
  if (override && override.trim()) return override;
  return process.cwd();
}

export function resolveDbPath(repoRoot: string): string {
  // Prefer the new env var, fall back to the old one with a one-time warning.
  // Drop the legacy fallback after v0.3.
  const override = process.env["AGENT_TRAIL_DB_PATH"] ?? process.env["VIBE_BOARD_DB_PATH"];
  if (process.env["VIBE_BOARD_DB_PATH"] && !process.env["AGENT_TRAIL_DB_PATH"]) {
    console.warn(
      "[agent-trail] VIBE_BOARD_DB_PATH is deprecated — set AGENT_TRAIL_DB_PATH instead. Falling back for this run.",
    );
  }
  if (override && override.trim()) return override;

  const resolved = join(repoRoot, DB_FILENAME);
  migrateDbFilename(repoRoot, resolved);
  return resolved;
}

// One-time rename: if a pre-v0.2 user has `vibe-board.db` but not `agent-trail.db`
// in the same directory, move it. Reversible by renaming back manually.
function migrateDbFilename(repoRoot: string, resolvedNew: string): void {
  if (existsSync(resolvedNew)) return;
  const legacy = join(repoRoot, LEGACY_DB_FILENAME);
  if (!existsSync(legacy)) return;
  try {
    renameSync(legacy, resolvedNew);
    console.log(`[agent-trail] renamed legacy DB: ${LEGACY_DB_FILENAME} → ${DB_FILENAME}`);
  } catch (err) {
    console.warn(`[agent-trail] could not auto-rename ${legacy}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
