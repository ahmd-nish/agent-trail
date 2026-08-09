import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PRD_OPEN_SOURCE 3.2 — `inventarium context` CLI.
// Shell out to the actual bin to catch argument-parsing regressions and
// import-path breakage — the same failure modes users hit.

const CLI_ENTRY = join(import.meta.dir, "index.ts");

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  const res = spawnSync("bun", [CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, INVENTARIUM_ROOT: cwd },
    encoding: "utf8",
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? -1 };
}

describe("inventarium context — PRD 3.2 CLI", () => {
  test("add appends a note to .inventarium/context/notes.md", () => {
    const tmp = mkdtempSync(join(tmpdir(), "at-cli-ctx-"));
    try {
      const { code, stdout } = runCli(["context", "add", "always use bun"], tmp);
      expect(code).toBe(0);
      expect(stdout).toContain("notes.md");
      const notes = readFileSync(join(tmp, ".inventarium", "context", "notes.md"), "utf8");
      expect(notes).toContain("# Notes");
      expect(notes).toContain("always use bun");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("add --file targets a custom markdown file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "at-cli-ctx-"));
    try {
      const { code } = runCli(["context", "add", "reviewer must be tagged", "--file", "conventions"], tmp);
      expect(code).toBe(0);
      const path = join(tmp, ".inventarium", "context", "conventions.md");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("reviewer must be tagged");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("add with no text prints usage and exits non-zero", () => {
    const tmp = mkdtempSync(join(tmpdir(), "at-cli-ctx-"));
    try {
      const { code, stderr } = runCli(["context", "add"], tmp);
      expect(code).not.toBe(0);
      expect(stderr).toContain("Usage");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("ls lists markdown files with sizes; empty prints hint", () => {
    const tmp = mkdtempSync(join(tmpdir(), "at-cli-ctx-"));
    try {
      // Empty first.
      const empty = runCli(["context", "ls"], tmp);
      expect(empty.code).toBe(0);
      expect(empty.stdout).toContain("(empty)");
      // Now seed two files and re-list.
      mkdirSync(join(tmp, ".inventarium", "context"), { recursive: true });
      writeFileSync(join(tmp, ".inventarium", "context", "a.md"), "# alpha\n", "utf8");
      writeFileSync(join(tmp, ".inventarium", "context", "b.md"), "# beta\n", "utf8");
      const { code, stdout } = runCli(["context", "ls"], tmp);
      expect(code).toBe(0);
      expect(stdout).toContain("a.md");
      expect(stdout).toContain("b.md");
      // Alphabetical.
      const idxA = stdout.indexOf("a.md");
      const idxB = stdout.indexOf("b.md");
      expect(idxA).toBeLessThan(idxB);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
