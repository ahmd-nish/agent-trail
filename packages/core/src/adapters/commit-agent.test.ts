import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { autoCommit, generateMessage } from "./commit-agent.ts";
import type { Task } from "../types/index.ts";

// PRD_OPEN_SOURCE 2.5 — commit agent. 2.6's autoPr is not tested here (needs
// gh CLI + a remote); the pure msg-generation + local commit path is.

function fakeTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1", boardId: "b1", title: "Add rate limiter", description: "Fixed-window rate limit on /api/*", status: "in_progress",
    priority: "high", assignee: "claude-code", tddEnabled: true, tddPhase: "verify_tests",
    mcps: [], skills: [], subagents: [], dependsOn: [], parallelGroup: null,
    activeForm: null, worktreePath: null, lastError: null,
    successCriteria: [], guardrails: [], epic: "API", sprint: null, reviewKind: "none",
    reviewer: null, additionalPrompt: null, model: null, modelTier: null,
    component: "middleware", externalDependencies: [], testCases: [],
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

describe("generateMessage (T2.5 pure)", () => {
  test("conventional style — feat with epic scope", () => {
    const msg = generateMessage(fakeTask(), " M foo.ts\n?? new.ts\n", "conventional");
    const line0 = msg.split("\n")[0]!;
    expect(line0.startsWith("feat(api): ")).toBe(true);
    expect(line0).toContain("add rate limiter");
    expect(msg).toContain("1 added");   // ?? counts as added
    expect(msg).toContain("1 modified");
  });

  test("plain style — uses task title verbatim, no scope", () => {
    const msg = generateMessage(fakeTask(), " M x.ts\n", "plain");
    expect(msg.split("\n")[0]).toBe("Add rate limiter");
  });

  test("`fix` in title → fix type", () => {
    const msg = generateMessage(fakeTask({ title: "Fix off-by-one in pagination" }), " M p.ts\n", "conventional");
    expect(msg.split("\n")[0].startsWith("fix(")).toBe(true);
  });

  test("all-test files → test type", () => {
    const msg = generateMessage(
      fakeTask({ title: "expand pagination coverage", epic: null, component: null }),
      "M  src/foo.test.ts\nA  src/bar.test.ts\n",
      "conventional",
    );
    expect(msg.split("\n")[0].startsWith("test: ")).toBe(true);
  });
});

describe("autoCommit dry-run (no side effects)", () => {
  test("no changes → performed=false, reason `no changes to commit`", () => {
    const tmp = mkdtempSync(join(tmpdir(), "at-commit-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: tmp });
      const res = autoCommit({ worktreePath: tmp, task: fakeTask(), execute: false });
      expect(res.performed).toBe(false);
      expect(res.reason).toBe("no changes to commit");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("with changes + execute=false → returns the message it would write", () => {
    const tmp = mkdtempSync(join(tmpdir(), "at-commit-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: tmp });
      writeFileSync(join(tmp, "hello.txt"), "hi\n");
      const res = autoCommit({ worktreePath: tmp, task: fakeTask(), execute: false });
      expect(res.performed).toBe(false);
      expect(res.reason).toBe("dry-run");
      expect(res.message).toContain("feat(api): add rate limiter");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("with changes + execute=true → actually commits and returns a sha", () => {
    const tmp = mkdtempSync(join(tmpdir(), "at-commit-"));
    try {
      const env = { ...process.env,
        GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t.local",
        GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t.local" };
      spawnSync("git", ["init", "-q"], { cwd: tmp, env });
      // Seed commit — commit-agent commits on top of whatever's there.
      writeFileSync(join(tmp, "README.md"), "# start\n");
      spawnSync("git", ["add", "-A"], { cwd: tmp, env });
      spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp, env });

      // Now the mock-generated file.
      writeFileSync(join(tmp, "src.ts"), "export const x = 1;\n");
      mkdirSync(join(tmp, "sub"), { recursive: true });
      writeFileSync(join(tmp, "sub", "y.ts"), "\n");

      // Point autoCommit at the tmp repo. Passing env via spawnSync isn't
      // available in autoCommit itself; the git-config approach is to set
      // the author on the repo instead.
      spawnSync("git", ["config", "user.name", "test"], { cwd: tmp });
      spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: tmp });

      const res = autoCommit({ worktreePath: tmp, task: fakeTask(), execute: true });
      expect(res.performed).toBe(true);
      expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
