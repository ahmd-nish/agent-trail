import { describe, test, expect } from "bun:test";
import { rankRelevantFiles, tokenize } from "./repo-map.ts";

const FILE_LIST = [
  "packages/server/src/routes/auth.ts",
  "packages/server/src/routes/notes.ts",
  "packages/server/src/routes/library.ts",
  "packages/web/src/components/Board.tsx",
  "packages/core/src/planner/index.ts",
  "README.md",
  "bun.lock",
  "node_modules/some-dep/index.js",
];

describe("repo map — PRD §4.4", () => {
  test("tokenize drops stopwords + short tokens + lowercases", () => {
    expect(tokenize("The Auth Route For Notes")).toEqual(["auth", "route", "notes"]);
    // 'the' and 'for' are stopwords; 'a' would be too short anyway
  });

  test("rankRelevantFiles surfaces path-substring matches first", () => {
    const ranked = rankRelevantFiles("add /auth login endpoint", {
      root: "/nonexistent",
      fileListOverride: FILE_LIST,
    });
    expect(ranked[0]!.path).toContain("auth.ts");
  });

  test("returns nothing when task terms all miss", () => {
    const ranked = rankRelevantFiles("do something obscure zzzqqq", {
      root: "/nonexistent",
      fileListOverride: FILE_LIST,
    });
    expect(ranked.length).toBe(0);
  });

  test("topN caps the returned list", () => {
    const ranked = rankRelevantFiles("packages server", {
      root: "/nonexistent",
      fileListOverride: FILE_LIST,
      topN: 2,
    });
    expect(ranked.length).toBeLessThanOrEqual(2);
  });

  test("pathPrefix filter narrows the search", () => {
    const ranked = rankRelevantFiles("routes library", {
      root: "/nonexistent",
      fileListOverride: FILE_LIST,
      pathPrefix: "packages/server/",
    });
    for (const r of ranked) expect(r.path.startsWith("packages/server/")).toBe(true);
    expect(ranked.some((r) => r.path.includes("library.ts"))).toBe(true);
  });

  test("source files ranked above README on equal term match", () => {
    const ranked = rankRelevantFiles("planner", {
      root: "/nonexistent",
      fileListOverride: ["planner.md", "planner/index.ts"],
    });
    expect(ranked[0]!.path).toBe("planner/index.ts");
  });
});
