import { describe, test, expect } from "bun:test";
import { orderCasesForRun } from "./test-case-order.ts";

// PRD_TESTING T0.5 — deterministic run-all ordering with auto-include and
// dangling-ref detection.

const c = (id: string, dep?: string) => ({ id, label: id, dependsOnCaseId: dep });

describe("orderCasesForRun (T0.5)", () => {
  test("no deps — order matches selected input", () => {
    const all = [c("a"), c("b"), c("c")];
    const { ordered, autoIncludedIds, danglingRefs, hasCycle } = orderCasesForRun(all, all);
    expect(ordered.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
    expect(autoIncludedIds).toEqual([]);
    expect(danglingRefs).toEqual([]);
    expect(hasCycle).toBe(false);
  });

  test("dependency runs first even when selected list places it last", () => {
    const all = [c("a"), c("b", "a")];
    // Selected in reverse order.
    const { ordered } = orderCasesForRun(all, [all[1]!, all[0]!]);
    expect(ordered.map((x) => x.id)).toEqual(["a", "b"]);
  });

  test("dependency excluded by tag filter is auto-included with a note", () => {
    const all = [c("createNote"), c("readNote", "createNote"), c("deleteTag")];
    const filtered = [all[1]!, all[2]!]; // user filtered out createNote
    const { ordered, autoIncludedIds } = orderCasesForRun(all, filtered);
    const ids = ordered.map((x) => x.id);
    expect(ids.indexOf("createNote")).toBeLessThan(ids.indexOf("readNote"));
    expect(autoIncludedIds).toEqual(["createNote"]);
  });

  test("dangling dependsOnCaseId is reported (case was deleted from under us)", () => {
    const all = [c("orphan", "gone")];
    const { danglingRefs } = orderCasesForRun(all, all);
    expect(danglingRefs).toEqual([{ caseId: "orphan", missingDepId: "gone" }]);
  });

  test("cycle detection still returns an ordered array (defensive)", () => {
    const all = [c("a", "b"), c("b", "a")];
    const { ordered, hasCycle } = orderCasesForRun(all, all);
    expect(hasCycle).toBe(true);
    expect(ordered.length).toBe(2);
  });

  test("diamond: deep-dependency ordering resolves correctly", () => {
    // a → b → d and a → c → d
    // orderCasesForRun sorts by depth from any root: a=0, {b,c}=1, d=2.
    const all = [c("a"), c("b", "a"), c("c", "a"), c("d", "b")];
    const { ordered } = orderCasesForRun(all, all);
    const ids = ordered.map((x) => x.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
  });

  test("selecting only a leaf pulls the whole chain in", () => {
    const all = [c("root"), c("mid", "root"), c("leaf", "mid")];
    const { ordered, autoIncludedIds } = orderCasesForRun(all, [all[2]!]);
    expect(ordered.map((x) => x.id)).toEqual(["root", "mid", "leaf"]);
    expect(autoIncludedIds.sort()).toEqual(["mid", "root"]);
  });
});
