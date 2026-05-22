import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export class WorktreeManager {
  constructor(private repoRoot: string) {}

  private get worktreesDir() {
    return join(this.repoRoot, ".worktrees");
  }

  async isGitRepo(): Promise<boolean> {
    return existsSync(join(this.repoRoot, ".git"));
  }

  async create(taskId: string): Promise<string | null> {
    if (!(await this.isGitRepo())) return null;
    const path = join(this.worktreesDir, taskId);
    if (existsSync(path)) return path;
    try {
      await this.git(["worktree", "add", "--detach", path, "HEAD"]);
    } catch (err) {
      console.warn(`[worktree] Could not create worktree for ${taskId}:`, err);
      return null;
    }
    return path;
  }

  async remove(taskId: string): Promise<void> {
    if (!(await this.isGitRepo())) return;
    const path = join(this.worktreesDir, taskId);
    if (!existsSync(path)) return;
    try {
      await this.git(["worktree", "remove", path, "--force"]);
    } catch {
      // best-effort
    }
  }

  private git(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, { cwd: this.repoRoot, stdio: "ignore" });
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} exited ${code}`)),
      );
      proc.on("error", reject);
    });
  }
}
