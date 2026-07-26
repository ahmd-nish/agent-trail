import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateAgent,
  saveAgent,
  readAgent,
  listAgents,
  deleteAgent,
  scaffoldAgent,
  importAgentFromUrl,
  parseAgentMarkdown,
} from "./store.ts";

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "at-lib-"));
}

describe("library store — PRD §4.1/§4.2", () => {
  test("parseAgentMarkdown handles missing frontmatter", () => {
    const p = parseAgentMarkdown("just a plain markdown file");
    expect(p.meta).toEqual({});
    expect(p.body).toContain("plain markdown");
  });

  test("validateAgent accepts a minimally-valid entry", () => {
    const md = `---\nname: sql-linter\ndescription: SQL best practices\ntags: sql, lint\n---\nbody here`;
    const v = validateAgent(md);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.entry.name).toBe("sql-linter");
      expect(v.entry.description).toBe("SQL best practices");
      expect(v.entry.tags).toEqual(["sql", "lint"]);
      expect(v.entry.checksum).toBeTruthy();
    }
  });

  test("validateAgent rejects missing name / description / bad name chars", () => {
    expect(validateAgent(`---\ndescription: x\n---\nbody`).ok).toBe(false);
    expect(validateAgent(`---\nname: x\n---\nbody`).ok).toBe(false);
    expect(validateAgent(`---\nname: has spaces\ndescription: x\n---\nbody`).ok).toBe(false);
    expect(validateAgent("").ok).toBe(false);
  });

  test("saveAgent + readAgent + listAgents round-trip", () => {
    const root = fresh();
    try {
      const entry = { name: "a", description: "d", tags: [], tools: [], version: null, source: null, checksum: "abc123", body: "hello" };
      const res = saveAgent(root, entry);
      expect(res.ok).toBe(true);
      const read = readAgent(root, "a");
      expect(read?.name).toBe("a");
      expect(read?.body).toContain("hello");
      const list = listAgents(root);
      expect(list.map((e) => e.name)).toEqual(["a"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("saveAgent refuses to overwrite by default; overwrite=true replaces", () => {
    const root = fresh();
    try {
      const e1 = { name: "x", description: "first", tags: [], tools: [], version: null, source: null, checksum: "1", body: "v1" };
      const e2 = { ...e1, description: "second", body: "v2", checksum: "2" };
      expect(saveAgent(root, e1).ok).toBe(true);
      const second = saveAgent(root, e2);
      expect(second.ok).toBe(false);
      expect(saveAgent(root, e2, { overwrite: true }).ok).toBe(true);
      const read = readAgent(root, "x")!;
      expect(read.description).toBe("second");
      expect(read.body).toContain("v2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleteAgent removes the file; returns false when absent", () => {
    const root = fresh();
    try {
      const e = { name: "gone", description: "d", tags: [], tools: [], version: null, source: null, checksum: "c", body: "b" };
      saveAgent(root, e);
      expect(deleteAgent(root, "gone")).toBe(true);
      expect(readAgent(root, "gone")).toBeNull();
      expect(deleteAgent(root, "gone")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scaffoldAgent produces a valid entry (round-trips through validateAgent)", () => {
    const scaff = scaffoldAgent("test-writer", "writes tests");
    // Render + reparse via saveAgent → readAgent.
    const root = fresh();
    try {
      saveAgent(root, scaff);
      const read = readAgent(root, "test-writer");
      expect(read).not.toBeNull();
      expect(read!.description).toBe("writes tests");
      expect(read!.body).toContain("TODO");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("importAgentFromUrl — happy path via mock fetch", async () => {
    const root = fresh();
    try {
      const remote = `---\nname: fetched\ndescription: pulled from the network\ntags: net\n---\n# fetched\n`;
      const mockFetch = (async () => new Response(remote, { status: 200 })) as unknown as typeof fetch;
      const r = await importAgentFromUrl(root, "https://example.invalid/agents/fetched.md", { fetchImpl: mockFetch });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.entry.name).toBe("fetched");
        expect(r.entry.source).toBe("https://example.invalid/agents/fetched.md");
      }
      // Disk check.
      const persisted = readFileSync(join(root, ".agent-trail/library/agents/fetched.md"), "utf-8");
      expect(persisted).toContain("name: fetched");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("importAgentFromUrl — HTTP error surfaces cleanly", async () => {
    const root = fresh();
    try {
      const mockFetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
      const r = await importAgentFromUrl(root, "https://x/y", { fetchImpl: mockFetch });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("404");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("importAgentFromUrl — invalid markdown → error, nothing saved", async () => {
    const root = fresh();
    try {
      const mockFetch = (async () => new Response("---\nname: bad name\n---\n", { status: 200 })) as unknown as typeof fetch;
      const r = await importAgentFromUrl(root, "https://x/y", { fetchImpl: mockFetch });
      expect(r.ok).toBe(false);
      expect(listAgents(root).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
