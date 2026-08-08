import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCodeIndex, type CodeIndex } from "./code-index.ts";
import { runCodeIndexBench, formatBenchReport } from "./code-index-bench.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "at-ci-bench-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content, "utf-8");
  }
  return root;
}

describe("runCodeIndexBench (§3.3)", () => {
  test("coverage uses exporting files as the denominator, not every file", async () => {
    const root = fixture({
      "a.ts": "export function one() {}\nexport function two() {}\n",
      "b.ts": "export const x = 1;\n",
      // A test file exports nothing. It must not count against the adapter —
      // there is no symbol there to resolve.
      "a.test.ts": `import { one } from "./a.ts";\ntest("x", () => one());\n`,
    });
    const corpus = ["a.ts", "b.ts", "a.test.ts"];
    const idx = new NativeCodeIndex({ root, fileListOverride: corpus });
    const r = await runCodeIndexBench(idx, { root, corpus });

    expect(r.coverage.filesTotal).toBe(3);
    expect(r.coverage.filesDeclaringExports).toBe(2);
    expect(r.coverage.filesWithSymbols).toBe(2);
    expect(r.coverage.rateAmongExporting).toBe(1);       // the gate metric
    expect(r.coverage.rate).toBeCloseTo(2 / 3, 4);       // the naive one
    expect(r.coverage.symbolsTotal).toBe(3);
    rmSync(root, { recursive: true, force: true });
  });

  test("blind spots name the shapes the extractor structurally cannot see", async () => {
    const root = fixture({
      "m.ts": [
        "export default function main() {}",
        'export * from "./other.ts";',
        'export { a, b } from "./other.ts";',
        "export function seen() {}",
      ].join("\n") + "\n",
    });
    const corpus = ["m.ts"];
    const r = await runCodeIndexBench(new NativeCodeIndex({ root, fileListOverride: corpus }), { root, corpus });

    expect(r.blindSpots.declaredExports).toBe(4);
    const byShape = Object.fromEntries(r.blindSpots.byShape.map((s) => [s.shape, s]));
    expect(byShape["export default"]!.missed).toBe(1);
    expect(byShape["export * (re-export)"]!.missed).toBe(1);
    expect(byShape["export { } (re-export list)"]!.missed).toBe(1);
    // These are real staleness false negatives: a signature change behind a
    // re-export cannot move the hash if the export was never captured.
    expect(r.blindSpots.missRate).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("a commented-out export is not counted as ground truth", async () => {
    const root = fixture({
      "c.ts": "/*\nexport function ghost() {}\n*/\n// export function alsoGhost() {}\nexport function real() {}\n",
    });
    const corpus = ["c.ts"];
    const r = await runCodeIndexBench(new NativeCodeIndex({ root, fileListOverride: corpus }), { root, corpus });
    expect(r.blindSpots.declaredExports).toBe(1);
    expect(r.blindSpots.missRate).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("an adapter that resolves nothing scores 0 coverage and 100% blind", async () => {
    const root = fixture({ "a.ts": "export function one() {}\n" });
    const nullIndex: CodeIndex = {
      name: "null-adapter", available: async () => true,
      symbolsInPaths: async () => [], findSymbol: async () => [],
      getSignature: async () => null, whoCalls: async () => [], indexedAtSha: async () => null,
    };
    const r = await runCodeIndexBench(nullIndex, { root, corpus: ["a.ts"] });
    expect(r.coverage.rateAmongExporting).toBe(0);
    expect(r.blindSpots.missRate).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("empty corpus degrades to zeros with a note rather than dividing by zero", async () => {
    const root = fixture({ "a.ts": "export const x = 1;\n" });
    const r = await runCodeIndexBench(new NativeCodeIndex({ root, fileListOverride: [] }), { root, corpus: [] });
    expect(r.coverage.rate).toBe(0);
    expect(r.coverage.rateAmongExporting).toBe(0);
    expect(r.latency.p50Ms).toBe(0);
    expect(r.notes.some((n) => n.includes("empty corpus"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("files deleted since the commit that touched them are skipped, not fatal", async () => {
    const root = fixture({ "a.ts": "export const x = 1;\n" });
    const corpus = ["a.ts", "deleted/gone.ts"];
    const r = await runCodeIndexBench(new NativeCodeIndex({ root, fileListOverride: corpus }), { root, corpus });
    expect(r.coverage.filesDeclaringExports).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("latency percentiles are populated and the gate verdict is computed", async () => {
    const root = fixture({ "a.ts": "export const x = 1;\n", "b.ts": "export const y = 2;\n" });
    const corpus = ["a.ts", "b.ts"];
    const r = await runCodeIndexBench(new NativeCodeIndex({ root, fileListOverride: corpus }), { root, corpus });
    expect(r.latency.samples).toBe(2);
    expect(r.latency.p99Ms).toBeGreaterThanOrEqual(r.latency.p50Ms);
    expect(r.latency.p99UnderGate).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("formatBenchReport renders both gates", async () => {
    const root = fixture({ "a.ts": "export function one() {}\n" });
    const corpus = ["a.ts"];
    const out = formatBenchReport(
      await runCodeIndexBench(new NativeCodeIndex({ root, fileListOverride: corpus }), { root, corpus }),
    );
    expect(out).toContain("GATE >= 50%");
    expect(out).toContain("p99 < 200ms");
    rmSync(root, { recursive: true, force: true });
  });
});
