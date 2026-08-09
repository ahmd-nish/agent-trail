import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHeuristicMemory,
  writeTaskMemory,
  readTaskMemory,
  listTaskMemories,
  buildL1Pack,
  memoriesDir,
} from "./memory.ts";

describe("task memory — PRD §4.4 (§D slice)", () => {
  test("buildHeuristicMemory extracts files from git diff + explicit list", () => {
    const mem = buildHeuristicMemory({
      task: { id: "t-1", title: "Add /notes endpoint", successCriteria: ["Returns 201"] },
      gitDiff: "diff --git a/src/notes.ts b/src/notes.ts\n@@\n+something\n",
      fileList: ["src/router.ts"],
      decisionKeys: ["auth-model"],
    });
    expect(mem.filesTouched).toContain("src/notes.ts");
    expect(mem.filesTouched).toContain("src/router.ts");
    expect(mem.decisionKeys).toEqual(["auth-model"]);
    expect(mem.summary).toContain("Add /notes endpoint");
    expect(mem.summary).toContain("Returns 201");
  });

  test("buildHeuristicMemory truncates oversize summaries", () => {
    const longDescription = "x".repeat(5000);
    const mem = buildHeuristicMemory({
      task: { id: "t-long", title: "Big", description: longDescription },
    });
    expect(mem.summary.length).toBeLessThanOrEqual(1200);
    expect(mem.summary).toContain("truncated");
  });

  test("writeTaskMemory + readTaskMemory round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "at-mem-"));
    try {
      const mem = buildHeuristicMemory({
        task: { id: "t-round", title: "Round trip", successCriteria: ["A"] },
        fileList: ["a.ts", "b.ts"],
        completedAt: "2026-07-25T12:00:00Z",
      });
      const path = writeTaskMemory(root, mem);
      expect(existsSync(path)).toBe(true);
      const read = readTaskMemory(root, "t-round");
      expect(read).not.toBeNull();
      expect(read!.taskId).toBe("t-round");
      expect(read!.taskTitle).toBe("Round trip");
      expect(read!.filesTouched).toEqual(["a.ts", "b.ts"]);
      expect(read!.completedAt).toBe("2026-07-25T12:00:00Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readTaskMemory returns null when the file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "at-mem-"));
    try {
      expect(readTaskMemory(root, "nope")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("listTaskMemories returns entries newest-first", () => {
    const root = mkdtempSync(join(tmpdir(), "at-mem-"));
    try {
      writeTaskMemory(root, buildHeuristicMemory({ task: { id: "old", title: "old" }, completedAt: "2026-07-01T00:00:00Z" }));
      writeTaskMemory(root, buildHeuristicMemory({ task: { id: "new", title: "new" }, completedAt: "2026-07-25T00:00:00Z" }));
      const list = listTaskMemories(root);
      expect(list.map((m) => m.taskId)).toEqual(["new", "old"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("memories live under .inventarium/context/memories/", () => {
    const root = mkdtempSync(join(tmpdir(), "at-mem-"));
    try {
      const dir = memoriesDir(root);
      expect(dir.endsWith(join(".inventarium", "context", "memories"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("L1 pack builder — strategic per-task context", () => {
  test("self block always present; no deps → pack is self only", () => {
    const root = mkdtempSync(join(tmpdir(), "at-pack-"));
    try {
      const pack = buildL1Pack(root, {
        id: "t-1",
        title: "Add /notes",
        description: "POST /notes creates a note",
        successCriteria: ["Returns 201"],
        dependsOn: [],
      });
      expect(pack.content).toContain("=== This task ===");
      expect(pack.content).toContain("Add /notes");
      expect(pack.content).toContain("[0] Returns 201");
      expect(pack.sources.length).toBe(1);
      expect(pack.sources[0]!.kind).toBe("self");
      expect(pack.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dependency memories appear in the pack when the memory files exist", () => {
    const root = mkdtempSync(join(tmpdir(), "at-pack-"));
    try {
      writeTaskMemory(root, buildHeuristicMemory({
        task: { id: "dep-1", title: "Design schema", successCriteria: ["notes table exists"] },
        fileList: ["src/db/schema.sql"],
      }));
      const pack = buildL1Pack(root, {
        id: "t-2", title: "CRUD endpoints", dependsOn: ["dep-1"],
      });
      expect(pack.content).toContain("=== Dependency: Design schema ===");
      expect(pack.content).toContain("src/db/schema.sql");
      expect(pack.sources.length).toBe(2);
      expect(pack.sources[1]!.kind).toBe("dependency");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing dependency memories are silently skipped (partial DAGs work)", () => {
    const root = mkdtempSync(join(tmpdir(), "at-pack-"));
    try {
      writeTaskMemory(root, buildHeuristicMemory({
        task: { id: "dep-1", title: "Design schema" },
      }));
      // dep-2 never wrote a memory
      const pack = buildL1Pack(root, {
        id: "t-3", title: "Combo", dependsOn: ["dep-1", "dep-2"],
      });
      expect(pack.sources.length).toBe(2); // self + dep-1 only
      expect(pack.content).toContain("Design schema");
      expect(pack.content).not.toContain("dep-2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("charCap enforces a hard ceiling; overflow gets clipped/truncated", () => {
    const root = mkdtempSync(join(tmpdir(), "at-pack-"));
    try {
      // Two big dep memories.
      for (const id of ["big-1", "big-2"]) {
        writeTaskMemory(root, {
          taskId: id, taskTitle: id, summary: "x".repeat(1500),
          filesTouched: [], decisionKeys: [], completedAt: "2026-07-25T00:00:00Z",
        });
      }
      const pack = buildL1Pack(root, {
        id: "t-cap", title: "Cap check", dependsOn: ["big-1", "big-2"],
      }, { charCap: 1200 });
      expect(pack.bytes).toBeLessThanOrEqual(1200);
      expect(pack.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
