import { describe, test, expect } from "bun:test";
import { hasOverlap, findConflict, normalisePath } from "./footprint.ts";

describe("footprint overlap — PRD §4.7", () => {
  test("empty lists never overlap", () => {
    expect(hasOverlap([], ["src/x.ts"])).toBe(false);
    expect(hasOverlap(["src/x.ts"], [])).toBe(false);
  });

  test("exact-same-file overlaps", () => {
    expect(hasOverlap(["src/notes.ts"], ["src/notes.ts"])).toBe(true);
  });

  test("different files under the same directory do NOT overlap", () => {
    expect(hasOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
  });

  test("directory prefix overlaps with file underneath", () => {
    expect(hasOverlap(["src/routes/"], ["src/routes/notes.ts"])).toBe(true);
    expect(hasOverlap(["src/routes/notes.ts"], ["src/routes/"])).toBe(true);
  });

  test("normalisePath strips leading ./ and collapses //", () => {
    expect(normalisePath("./src//notes.ts")).toBe("src/notes.ts");
    expect(normalisePath("src/notes.ts/")).toBe("src/notes.ts");
  });

  test("findConflict returns the id of the first overlapping running task", () => {
    const running = new Map<string, string[]>([
      ["t-1", ["src/router.ts"]],
      ["t-2", ["src/notes.ts"]],
    ]);
    expect(findConflict(["src/notes.ts"], running)).toBe("t-2");
    expect(findConflict(["docs/README.md"], running)).toBeNull();
  });
});
