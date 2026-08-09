import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeCodeIndex, fileUrn, moduleUrn, parseUrn, pathUrns, resolveCodeIndex,
  symbolUrn, toPosixPath, type CodeIndex,
} from "./code-index.ts";

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "at-code-index-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  return root;
}

describe("URN addressing (§3.1 rule 1)", () => {
  test("builds the three URN forms", () => {
    expect(symbolUrn("packages/core/auth.ts", "createSession"))
      .toBe("sym:packages/core/auth.ts#createSession");
    expect(fileUrn("packages/core/auth.ts")).toBe("file:packages/core/auth.ts");
    expect(moduleUrn("packages/core/")).toBe("module:packages/core");
  });

  test("normalizes separators and leading ./ so two machines agree", () => {
    // The whole point of rule 1: an edge written on one machine must join on
    // another. A stray "./" prefix would silently split the join.
    expect(toPosixPath("./packages/core/auth.ts")).toBe("packages/core/auth.ts");
    expect(fileUrn("./a/b.ts")).toBe("file:a/b.ts");
  });

  test("round-trips through parseUrn", () => {
    expect(parseUrn(symbolUrn("a/b.ts", "foo"))).toEqual({ kind: "sym", path: "a/b.ts", name: "foo" });
    expect(parseUrn(fileUrn("a/b.ts"))).toEqual({ kind: "file", path: "a/b.ts" });
    expect(parseUrn(moduleUrn("a/b"))).toEqual({ kind: "module", path: "a/b" });
  });

  test("a symbol name containing # still parses — last # wins", () => {
    expect(parseUrn("sym:a/b.ts#weird#name")).toEqual({ kind: "sym", path: "a/b.ts#weird", name: "name" });
  });

  test("returns null rather than throwing on garbage", () => {
    // Edge rows are data. One bad row must not take down a pack build.
    for (const bad of ["", "nope", "sym:", "sym:no-hash", "sym:a.ts#", "file:", "module:"]) {
      expect(parseUrn(bad)).toBeNull();
    }
  });

  test("pathUrns yields the file plus every ancestor module", () => {
    expect(pathUrns("packages/core/src/auth.ts")).toEqual([
      "file:packages/core/src/auth.ts",
      "module:packages/core/src",
      "module:packages/core",
      "module:packages",
    ]);
  });
});

describe("NativeCodeIndex (§3.2 control)", () => {
  const SESSION = `
import { hash } from "./hash.ts";

export interface Session { id: string; userId: string }

export async function createSession(
  userId: string,
  ttlMs?: number,
): Promise<Session> {
  return { id: hash(userId), userId };
}

export const verifySession = (token: string) => null;

export class SessionStore {}

export type Token = string;
`;

  test("symbolsInPaths returns typed refs with lines and signatures", async () => {
    const root = fixtureRepo({ "src/session.ts": SESSION });
    const idx = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts"] });
    const syms = await idx.symbolsInPaths(["src/session.ts"]);
    const byName = Object.fromEntries(syms.map((s) => [s.name, s]));

    expect(Object.keys(byName).sort()).toEqual(
      ["Session", "SessionStore", "Token", "createSession", "verifySession"],
    );
    expect(byName.createSession!.kind).toBe("function");
    expect(byName.SessionStore!.kind).toBe("class");
    expect(byName.Session!.kind).toBe("type");
    // Multiline signature collapses to one line — never a file body (rule 4).
    expect(byName.createSession!.signature).toContain("createSession");
    expect(byName.createSession!.signature).toContain("ttlMs");
    rmSync(root, { recursive: true, force: true });
  });

  test("line numbers survive block comments", async () => {
    // Regression guard: the extractor blanks block comments instead of
    // deleting them, so `sym:` line addressing stays true to the file.
    const root = fixtureRepo({
      "a.ts": `/*\n multi\n line\n comment\n*/\nexport function afterComment() {}\n`,
    });
    const idx = new NativeCodeIndex({ root, fileListOverride: ["a.ts"] });
    const [sym] = await idx.symbolsInPaths(["a.ts"]);
    expect(sym!.name).toBe("afterComment");
    expect(sym!.line).toBe(6);
    rmSync(root, { recursive: true, force: true });
  });

  test("resolves a union type alias whose RHS starts on the next line", async () => {
    // 15 of 44 type aliases in this repo are written this way. Requiring the
    // RHS on the declaration line missed every one of them.
    const root = fixtureRepo({
      "t.ts": `export type TaskStatus =\n  | "backlog"\n  | "done";\n\nexport type Inline = string;\n`,
    });
    const idx = new NativeCodeIndex({ root, fileListOverride: ["t.ts"] });
    const syms = await idx.symbolsInPaths(["t.ts"]);
    const byName = Object.fromEntries(syms.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(["Inline", "TaskStatus"]);
    expect(byName.TaskStatus!.signature).toContain("backlog");
    expect(byName.TaskStatus!.line).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("re-exports are kinded `reexport`, not guessed as function or type", async () => {
    const root = fixtureRepo({
      "r.ts": `export * from "./a.ts";\nexport { one, two as three } from "./b.ts";\nexport * as ns from "./c.ts";\n`,
    });
    const idx = new NativeCodeIndex({ root, fileListOverride: ["r.ts"] });
    const syms = await idx.symbolsInPaths(["r.ts"]);
    expect(syms.map((s) => s.name).sort()).toEqual(["*", "ns", "one", "three"]);
    // Resolving the true kind needs cross-module resolution; claiming one
    // would be a fabrication persisted into §J's edges.
    expect(new Set(syms.map((s) => s.kind))).toEqual(new Set(["reexport"]));
    rmSync(root, { recursive: true, force: true });
  });

  test("ignores files it cannot parse rather than guessing", async () => {
    const root = fixtureRepo({ "readme.md": "# not code", "q.sql": "CREATE TABLE t (id TEXT);" });
    const idx = new NativeCodeIndex({ root, fileListOverride: ["readme.md", "q.sql"] });
    // Rule 3 — empty is a valid answer. Claiming coverage here would inflate
    // the §3.3 denominator dishonestly.
    expect(await idx.symbolsInPaths(["readme.md", "q.sql"])).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("missing files degrade silently", async () => {
    const root = fixtureRepo({ "a.ts": "export const x = 1;" });
    const idx = new NativeCodeIndex({ root, fileListOverride: ["a.ts"] });
    expect(await idx.symbolsInPaths(["does/not/exist.ts"])).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("findSymbol and getSignature resolve across the file list", async () => {
    const root = fixtureRepo({ "src/session.ts": SESSION, "src/other.ts": "export const y = 2;" });
    const idx = new NativeCodeIndex({ root, fileListOverride: ["src/session.ts", "src/other.ts"] });
    const hits = await idx.findSymbol("createSession");
    expect(hits.length).toBe(1);
    expect(hits[0]!.path).toBe("src/session.ts");
    expect(await idx.getSignature({ path: "src/session.ts", name: "verifySession" })).toContain("verifySession");
    expect(await idx.getSignature({ path: "src/session.ts", name: "nope" })).toBeNull();
  });

  test("whoCalls finds referencing files and excludes the declaration site", async () => {
    const root = fixtureRepo({
      "src/session.ts": SESSION,
      "src/api.ts": `import { createSession } from "./session.ts";\nawait createSession("u1");\n`,
      "src/unrelated.ts": `export const z = 3;\n`,
      "src/comment.ts": `// createSession is mentioned only in a comment\nexport const w = 4;\n`,
    });
    const idx = new NativeCodeIndex({
      root,
      fileListOverride: ["src/session.ts", "src/api.ts", "src/unrelated.ts", "src/comment.ts"],
    });
    const callers = await idx.whoCalls({ path: "src/session.ts", name: "createSession" });
    const paths = callers.map((c) => c.path);
    expect(paths).toContain("src/api.ts");
    expect(paths).not.toContain("src/session.ts");   // never its own decl site
    expect(paths).not.toContain("src/unrelated.ts");
    expect(paths).not.toContain("src/comment.ts");   // comment-only mention
    rmSync(root, { recursive: true, force: true });
  });

  test("re-reads a file after it changes on disk", async () => {
    const root = fixtureRepo({ "a.ts": "export function before() {}\n" });
    const idx = new NativeCodeIndex({ root, fileListOverride: ["a.ts"] });
    expect((await idx.symbolsInPaths(["a.ts"]))[0]!.name).toBe("before");
    // mtime-keyed cache — an edit made outside inventarium must be visible,
    // which is the §4.2e failure mode in miniature.
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, "a.ts"), "export function after() {}\n", "utf-8");
    expect((await idx.symbolsInPaths(["a.ts"]))[0]!.name).toBe("after");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("resolveCodeIndex (§11 risk 1 — adapter churn)", () => {
  test("defaults to native", async () => {
    const idx = await resolveCodeIndex({ root: process.cwd() });
    expect(idx.name).toBe("native");
  });

  test("an unknown backend name falls back instead of throwing", async () => {
    const idx = await resolveCodeIndex({ root: process.cwd(), prefer: "does-not-exist" });
    expect(idx.name).toBe("native");
  });

  test("a backend that reports unavailable falls back", async () => {
    const dead: CodeIndex = {
      name: "dead", available: async () => false,
      symbolsInPaths: async () => [], findSymbol: async () => [],
      getSignature: async () => null, whoCalls: async () => [], indexedAtSha: async () => null,
    };
    const idx = await resolveCodeIndex({
      root: process.cwd(), prefer: "dead", registry: { dead: () => dead },
    });
    expect(idx.name).toBe("native");
  });

  test("a backend that throws on construction falls back", async () => {
    // A dead dependency must be a config change, not a rewrite — and not an
    // outage either.
    const idx = await resolveCodeIndex({
      root: process.cwd(), prefer: "boom",
      registry: { boom: () => { throw new Error("backend exploded"); } },
    });
    expect(idx.name).toBe("native");
  });

  test("a healthy backend is selected over native", async () => {
    const live: CodeIndex = {
      name: "live", available: async () => true,
      symbolsInPaths: async () => [], findSymbol: async () => [],
      getSignature: async () => null, whoCalls: async () => [], indexedAtSha: async () => "abc",
    };
    const idx = await resolveCodeIndex({
      root: process.cwd(), prefer: "live", registry: { live: () => live },
    });
    expect(idx.name).toBe("live");
  });
});
