import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksDir, installPostMergeHook, uninstallPostMergeHook } from "./hooks.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "at-hooks-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}

describe("post-merge hook (§4.2e — optimization only)", () => {
  test("installs an executable hook", () => {
    const root = gitRepo();
    const res = installPostMergeHook(root);
    expect(res.installed).toBe(true);
    const body = readFileSync(res.path!, "utf8");
    expect(body).toContain("inventarium:post-merge");
    // Must never block a merge — every failure path exits 0.
    expect(body).toContain("exit 0");
    expect(body).toContain("|| true");
    rmSync(root, { recursive: true, force: true });
  });

  test("refuses to clobber a hook it did not write", () => {
    // Silently overwriting a user's existing hook would be hostile.
    const root = gitRepo();
    const dir = hooksDir(root)!;
    const path = join(dir, "post-merge");
    writeFileSync(path, "#!/bin/sh\necho mine\n", "utf8");

    const res = installPostMergeHook(root);
    expect(res.installed).toBe(false);
    expect(res.reason).toContain("not written by inventarium");
    expect(readFileSync(path, "utf8")).toContain("echo mine");
    rmSync(root, { recursive: true, force: true });
  });

  test("force replaces a foreign hook when explicitly asked", () => {
    const root = gitRepo();
    writeFileSync(join(hooksDir(root)!, "post-merge"), "#!/bin/sh\necho mine\n", "utf8");
    const res = installPostMergeHook(root, { force: true });
    expect(res.installed).toBe(true);
    expect(readFileSync(res.path!, "utf8")).toContain("inventarium:post-merge");
    rmSync(root, { recursive: true, force: true });
  });

  test("re-installing over its own hook is idempotent", () => {
    const root = gitRepo();
    installPostMergeHook(root);
    const second = installPostMergeHook(root);
    expect(second.installed).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("uninstall leaves a foreign hook alone", () => {
    const root = gitRepo();
    const path = join(hooksDir(root)!, "post-merge");
    writeFileSync(path, "#!/bin/sh\necho mine\n", "utf8");
    const res = uninstallPostMergeHook(root);
    expect(res.reason).toContain("left alone");
    expect(readFileSync(path, "utf8")).toContain("echo mine");
    rmSync(root, { recursive: true, force: true });
  });

  test("outside a git repo it reports rather than throws", () => {
    const plain = mkdtempSync(join(tmpdir(), "at-nogit-"));
    const res = installPostMergeHook(plain);
    expect(res.installed).toBe(false);
    expect(res.reason).toContain("not a git repository");
    rmSync(plain, { recursive: true, force: true });
  });

  test("honours a custom core.hooksPath", () => {
    const root = gitRepo();
    spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root });
    const res = installPostMergeHook(root);
    expect(res.installed).toBe(true);
    expect(existsSync(join(root, ".githooks", "post-merge"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
