import { spawnSync } from "node:child_process";
import type { Database } from "bun:sqlite";

export function capturePostExecutionArtifacts(
  taskId: string,
  executionId: string,
  worktreePath: string,
  db: Database,
): void {
  const now = new Date().toISOString();

  // Diff of all tracked file changes vs last commit
  const diff = spawnSync("git", ["diff", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (!diff.error && diff.stdout?.trim()) {
    db.query(
      "INSERT INTO artifacts (id, task_id, execution_id, kind, content, created_at) VALUES (?, ?, ?, 'git_diff', ?, ?)",
    ).run(crypto.randomUUID(), taskId, executionId, diff.stdout, now);
  }

  // File list — includes new/modified/deleted/untracked files
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (!status.error && status.stdout?.trim()) {
    db.query(
      "INSERT INTO artifacts (id, task_id, execution_id, kind, content, created_at) VALUES (?, ?, ?, 'file_list', ?, ?)",
    ).run(crypto.randomUUID(), taskId, executionId, status.stdout, now);
  }
}
