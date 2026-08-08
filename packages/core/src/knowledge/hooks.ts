// knowledgelayer §4.2e — the `post-merge` hook.
//
// **This is an optimization and nothing else.** Correctness stays pull-based:
// checkContractValidity() re-resolves signatures at pack time, so a fresh
// clone, a machine where the hook was never installed, or a user who declines
// it all get the right answer — just a few milliseconds later.
//
// That constraint is deliberate. A hook that MUST run to be correct is a hook
// that is silently wrong on every machine where it did not, which is precisely
// the assumption §4.2e says never to make about a repo.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const MARKER = "# agent-trail:post-merge";

const HOOK_BODY = `#!/bin/sh
${MARKER}
# Precomputes contract validity after a merge/pull so the next task pack does
# not pay for it. Purely an optimization — agent-trail derives staleness at
# pack time regardless, so removing this file changes speed, never answers.
# Never blocks the merge: every failure path exits 0.
if command -v agent-trail >/dev/null 2>&1; then
  agent-trail knowledge revalidate --quiet >/dev/null 2>&1 || true
fi
exit 0
`;

export interface HookInstallResult {
  installed: boolean;
  path: string | null;
  reason: string;
}

/** Resolve the hooks directory, honouring a custom `core.hooksPath`. */
export function hooksDir(repoRoot: string): string | null {
  try {
    const res = spawnSync("git", ["-C", repoRoot, "rev-parse", "--git-path", "hooks"], {
      encoding: "utf8", timeout: 3000,
    });
    if (res.status !== 0) return null;
    const rel = res.stdout.trim();
    if (!rel) return null;
    return rel.startsWith("/") ? rel : join(repoRoot, rel);
  } catch {
    return null;
  }
}

/**
 * Install the hook. Refuses to clobber a `post-merge` this tool did not write —
 * silently overwriting someone's existing hook would be a genuinely hostile
 * thing for a dev tool to do.
 */
export function installPostMergeHook(repoRoot: string, opts: { force?: boolean } = {}): HookInstallResult {
  const dir = hooksDir(repoRoot);
  if (!dir) return { installed: false, path: null, reason: "not a git repository" };

  const path = join(dir, "post-merge");
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8");
      if (existing.includes(MARKER)) {
        writeFileSync(path, HOOK_BODY, "utf8");
        chmodSync(path, 0o755);
        return { installed: true, path, reason: "updated existing agent-trail hook" };
      }
      if (!opts.force) {
        return { installed: false, path, reason: "a post-merge hook already exists and was not written by agent-trail — pass force to replace it" };
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HOOK_BODY, "utf8");
    chmodSync(path, 0o755);
    return { installed: true, path, reason: "installed" };
  } catch (err) {
    return { installed: false, path, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove the hook, but only if agent-trail wrote it. */
export function uninstallPostMergeHook(repoRoot: string): HookInstallResult {
  const dir = hooksDir(repoRoot);
  if (!dir) return { installed: false, path: null, reason: "not a git repository" };
  const path = join(dir, "post-merge");
  try {
    if (!existsSync(path)) return { installed: false, path, reason: "no hook installed" };
    if (!readFileSync(path, "utf8").includes(MARKER)) {
      return { installed: false, path, reason: "post-merge hook was not written by agent-trail — left alone" };
    }
    writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
    return { installed: false, path, reason: "removed" };
  } catch (err) {
    return { installed: false, path, reason: err instanceof Error ? err.message : String(err) };
  }
}

export { MARKER as POST_MERGE_MARKER, HOOK_BODY as POST_MERGE_HOOK_BODY };
