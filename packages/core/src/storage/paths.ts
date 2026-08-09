import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Single source of truth for on-disk identity.
//
// The product has been renamed twice: vibe-board → agent-trail → inventarium.
// Each rename is handled at FILE level below, so an existing install keeps its
// data without anyone moving anything by hand. The chain is walked oldest-first
// so a machine that skipped a release still lands on the current name.
export const DB_FILENAME = "inventarium.db";
const LEGACY_DB_FILENAMES = ["agent-trail.db", "vibe-board.db"];

/** Per-project state directory: context store, state.json, worktrees. */
export const STATE_DIRNAME = ".inventarium";
const LEGACY_STATE_DIRNAMES = [".agent-trail"];

/**
 * Read an env var under its current name, falling back to the pre-rename name.
 *
 * Renaming env vars silently breaks every shell profile, CI job and compose
 * file that referenced the old ones, and the failure mode is the worst kind:
 * the process starts fine and quietly uses the wrong path.
 */
export function envVar(name: string): string | undefined {
  const current = process.env[`INVENTARIUM_${name}`];
  if (current && current.trim()) return current;
  const legacy = process.env[`AGENT_TRAIL_${name}`];
  if (legacy && legacy.trim()) {
    if (!warnedEnv.has(name)) {
      warnedEnv.add(name);
      console.warn(
        `[inventarium] AGENT_TRAIL_${name} is deprecated — set INVENTARIUM_${name} instead. Falling back for this run.`,
      );
    }
    return legacy;
  }
  return undefined;
}
const warnedEnv = new Set<string>();

// The project root — where the user's DB, .worktrees/, and .mcp.json live.
// For `npx inventarium` this is the user's CWD; for local dev it's overridden
// via INVENTARIUM_ROOT so worktrees stay next to the source tree.
export function resolveProjectRoot(): string {
  return envVar("ROOT") ?? process.cwd();
}

export function resolveDbPath(repoRoot: string): string {
  const override = envVar("DB_PATH");
  if (override) return override;

  const resolved = join(repoRoot, DB_FILENAME);
  migrateName(repoRoot, resolved, LEGACY_DB_FILENAMES, "DB");
  return resolved;
}

/** Absolute path to the project's state directory, migrating a legacy one. */
export function resolveStateDir(repoRoot: string): string {
  const resolved = join(repoRoot, STATE_DIRNAME);
  migrateName(repoRoot, resolved, LEGACY_STATE_DIRNAMES, "state directory");
  return resolved;
}

/**
 * One-time rename. Walks the legacy names oldest-last and moves the first one
 * found. No-ops when the current name already exists, so it can never clobber
 * live data, and it is reversible by renaming back.
 */
function migrateName(repoRoot: string, resolvedNew: string, legacyNames: string[], label: string): void {
  if (existsSync(resolvedNew)) {
    // Both names present. Do NOT merge — that risks clobbering current data
    // with stale data. But do not stay silent either: the legacy copy holds
    // real history the user can no longer see, and a rename that quietly
    // orphans data is worse than one that fails loudly.
    for (const legacyName of legacyNames) {
      if (existsSync(join(repoRoot, legacyName))) {
        console.warn(
          `[inventarium] both ${legacyName} and ${resolvedNew.split("/").pop()} exist — the legacy ${label} was left untouched. ` +
          `Merge it by hand if it holds data you still need.`,
        );
        return;
      }
    }
    return;
  }
  for (const legacyName of legacyNames) {
    const legacy = join(repoRoot, legacyName);
    if (!existsSync(legacy)) continue;
    try {
      renameSync(legacy, resolvedNew);
      console.log(`[inventarium] renamed legacy ${label}: ${legacyName} → ${resolvedNew.split("/").pop()}`);
    } catch (err) {
      console.warn(
        `[inventarium] could not auto-rename ${legacy}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
}

/**
 * Per-user state directory (`~/.inventarium`) — encrypted secrets, runner state.
 * Migrates a pre-rename `~/.agent-trail` the same way the project dir does.
 */
export function resolveHomeStateDir(): string {
  const home = homedir();
  const resolved = join(home, STATE_DIRNAME);
  migrateName(home, resolved, LEGACY_STATE_DIRNAMES, "home state directory");
  return resolved;
}

/**
 * Run every on-disk migration once, at process start.
 *
 * Most call sites join `.inventarium` directly rather than going through the
 * resolvers. That is fine — but ONLY if the rename has already happened by the
 * time they run. Calling this from each entry point makes that true, instead of
 * depending on which code path happens to touch a resolver first.
 */
export function migrateLegacyPaths(projectRoot?: string): void {
  try {
    const root = projectRoot ?? resolveProjectRoot();
    resolveDbPath(root);
    resolveStateDir(root);
    resolveHomeStateDir();
  } catch { /* migration is best-effort; never block startup */ }
}
