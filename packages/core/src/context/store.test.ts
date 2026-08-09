import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDecision,
  addNote,
  contextDir,
  ensureContextDir,
  loadConstitution,
} from "./store.ts";

function fresh(prefix = "at-ctx-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("context store — PRD 3.2/3.3/3.4", () => {
  test("appendDecision creates decisions.md with heading + entry", () => {
    const root = fresh();
    try {
      const path = appendDecision(root, {
        taskTitle: "auth flow",
        question: "OAuth or magic link?",
        answer: "Magic link — the free tier can't afford Auth0 seats.",
        author: "nish",
        now: new Date("2026-07-25T00:00:00Z"),
      });
      const text = readFileSync(path, "utf8");
      expect(text).toContain("# Decisions");
      expect(text).toContain("## 2026-07-25 — auth flow");
      expect(text).toContain("**Q:** OAuth or magic link?");
      expect(text).toContain("**A:** Magic link");
      expect(text).toContain("_— nish_");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appendDecision on an existing file appends without duplicating the heading", () => {
    const root = fresh();
    try {
      appendDecision(root, {
        taskTitle: "one", question: "A?", answer: "yes",
        author: "nish", now: new Date("2026-07-25T00:00:00Z"),
      });
      const path = appendDecision(root, {
        taskTitle: "two", question: "B?", answer: "no",
        author: "nish", now: new Date("2026-07-25T00:00:00Z"),
      });
      const text = readFileSync(path, "utf8");
      const headingCount = (text.match(/^# Decisions$/gm) ?? []).length;
      expect(headingCount).toBe(1);
      expect(text).toContain("## 2026-07-25 — one");
      expect(text).toContain("## 2026-07-25 — two");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("addNote defaults to notes.md and prepends a title on first write", () => {
    const root = fresh();
    try {
      const path = addNote(root, {
        text: "use bun, never npm", author: "nish",
        now: new Date("2026-07-25T00:00:00Z"),
      });
      const text = readFileSync(path, "utf8");
      expect(path.endsWith("notes.md")).toBe(true);
      expect(text).toContain("# Notes");
      expect(text).toContain("- (2026-07-25, nish) use bun, never npm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("addNote respects a custom file + strips path-traversal characters", () => {
    const root = fresh();
    try {
      const path = addNote(root, {
        text: "always Postgres",
        file: "../../evil/conventions",
        author: "nish",
        now: new Date("2026-07-25T00:00:00Z"),
      });
      // The path-separator characters must be sanitized — no escaping the context dir.
      const dir = contextDir(root);
      expect(path.startsWith(`${dir}/`)).toBe(true);
      // The suffix (everything after the context dir) must be a single filename
      // segment — no nested traversal.
      const filename = path.slice(dir.length + 1);
      expect(filename.includes("/")).toBe(false);
      expect(filename.endsWith(".md")).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("always Postgres");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConstitution returns empty when nothing exists", () => {
    const root = fresh();
    try {
      const c = loadConstitution(root);
      expect(c.content).toBe("");
      expect(c.sources.length).toBe(0);
      expect(c.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConstitution reads CLAUDE.md + every markdown file in context/, sorted", () => {
    const root = fresh();
    try {
      writeFileSync(join(root, "CLAUDE.md"), "Root of the project — TypeScript, Bun.", "utf8");
      ensureContextDir(root);
      writeFileSync(join(contextDir(root), "conventions.md"), "Use Bun, never Node.", "utf8");
      writeFileSync(join(contextDir(root), "architecture.md"), "SQLite is the storage layer.", "utf8");
      const c = loadConstitution(root);
      expect(c.content).toContain("=== CLAUDE.md ===");
      expect(c.content).toContain("Root of the project");
      expect(c.content).toContain("=== .inventarium/context/architecture.md ===");
      expect(c.content).toContain("=== .inventarium/context/conventions.md ===");
      // Ordering: CLAUDE.md first, then context files alphabetically.
      const idxRoot = c.content.indexOf("=== CLAUDE.md ===");
      const idxArch = c.content.indexOf("architecture.md ===");
      const idxConv = c.content.indexOf("conventions.md ===");
      expect(idxRoot).toBeLessThan(idxArch);
      expect(idxArch).toBeLessThan(idxConv);
      expect(c.sources.length).toBe(3);
      expect(c.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConstitution enforces the char cap and marks truncated=true", () => {
    const root = fresh();
    try {
      ensureContextDir(root);
      const bigFile = "X".repeat(500);
      writeFileSync(join(contextDir(root), "big.md"), bigFile, "utf8");
      const c = loadConstitution(root, { charCap: 200 });
      expect(c.content.length).toBeLessThanOrEqual(200);
      expect(c.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConstitution ignores non-markdown files in context/", () => {
    const root = fresh();
    try {
      ensureContextDir(root);
      writeFileSync(join(contextDir(root), "conventions.md"), "keep me", "utf8");
      writeFileSync(join(contextDir(root), "state.json"), "{\"skip\": true}", "utf8");
      const c = loadConstitution(root);
      expect(c.content).toContain("conventions.md");
      expect(c.content).not.toContain("state.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConstitution silently skips subdirectories in context/", () => {
    const root = fresh();
    try {
      ensureContextDir(root);
      mkdirSync(join(contextDir(root), "memories"), { recursive: true });
      writeFileSync(join(contextDir(root), "conventions.md"), "keep me", "utf8");
      const c = loadConstitution(root);
      expect(c.sources.length).toBe(1);
      expect(c.content).toContain("conventions.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
