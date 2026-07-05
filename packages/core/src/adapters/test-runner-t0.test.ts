import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTests, runCommand, escapeFilterForRunner, DEFAULT_TEST_TIMEOUT_MS, DEFAULT_TEST_OUTPUT_CAP } from "./test-runner.ts";

// PRD_TESTING Phase T0 correctness patches.
//   T0.1 timeout + output cap
//   T0.2 runCommand executedCount fix
//   T0.4 filter escape per runner
//
// T0.3 lives in packages/web/src/components/task-detail/generate-test-cases.ts
// and is tested at that layer; T0.5 pure-function tests in
// packages/web/src/lib/test-case-order.test.ts; T0.6 (foreign_keys pragma)
// is exercised as a side effect of any cascade-delete test.

function seedPassingSuite(root: string): string {
  const dir = join(root, "pass"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t0-pass", type: "module", scripts: { test: "bun test" } }));
  writeFileSync(join(dir, "sanity.test.ts"), `
    import { test, expect } from "bun:test";
    test("green", () => { expect(1).toBe(1); });
  `, "utf-8");
  return dir;
}

describe("T0.1 — runTests + runCommand honor timeout and output cap", () => {
  test("exports sensible defaults", () => {
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_TEST_OUTPUT_CAP).toBe(5 * 1024 * 1024);
  });

  test("runCommand: a hanging command is killed by the timeout and marked timedOut", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "t0-timeout-"));
    try {
      const res = await runCommand("sleep 10", tmp, { timeoutMs: 300 });
      expect(res.timedOut).toBe(true);
      expect(res.passed).toBe(false);
      expect(res.ranSomething).toBe(false);
      // The whole thing should have ended within ~a few seconds (300ms timeout
      // + 3s SIGKILL grace) — nowhere near the sleep's 10s.
      expect(res.durationMs).toBeLessThan(6000);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }, 15000);

  test("runCommand: chatty command is truncated at the output cap with a marker", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "t0-cap-"));
    try {
      // Emit ~200 KB then exit. Cap at 8 KB.
      const res = await runCommand(`yes X | head -c 200000`, tmp, { outputCap: 8000, timeoutMs: 5000 });
      expect(res.outputTruncated).toBe(true);
      expect(res.output).toContain("[...output truncated at 8000 bytes]");
      // Body byte count is loose (cap-plus-marker) — assert the cap held.
      // 8000 bytes plus marker (~40 chars) is the ceiling.
      expect(res.output.length).toBeLessThanOrEqual(8000 + 80);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }, 15000);

  test("runTests: a healthy suite still passes with the default timeout in place", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "t0-passes-"));
    try {
      const workDir = seedPassingSuite(tmp);
      const res = await runTests(workDir);
      expect(res.passed).toBe(true);
      expect(res.timedOut).toBe(false);
      expect(res.outputTruncated).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }, 30000);
});

describe("T0.2 — runCommand executedCount reflects success/failure", () => {
  test("successful command reports executedCount = 1", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "t0-cmdok-"));
    try {
      const res = await runCommand("true", tmp, { timeoutMs: 5000 });
      expect(res.passed).toBe(true);
      expect(res.executedCount).toBe(1);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("failing command reports executedCount = 0 (was buggy `ok ? 1 : 1`)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "t0-cmdfail-"));
    try {
      const res = await runCommand("false", tmp, { timeoutMs: 5000 });
      expect(res.passed).toBe(false);
      expect(res.executedCount).toBe(0);
      expect(res.ranSomething).toBe(true); // the command DID run — it just returned non-zero
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("T0.4 — filter is escaped per runner's pattern syntax", () => {
  test("bun / jest / vitest: regex metacharacters are escaped as literals", () => {
    // A caller passing `POST /shorten (v2)` used to be treated as a regex,
    // matching things like "POST /shorten v2" too. Now backslash-escaped.
    const raw = "POST /shorten (v2).status?";
    const bun    = escapeFilterForRunner("bun", raw);
    const jest   = escapeFilterForRunner("jest", raw);
    const vitest = escapeFilterForRunner("vitest", raw);
    expect(bun).toBe("POST /shorten \\(v2\\)\\.status\\?");
    expect(jest).toBe(bun);
    expect(vitest).toBe(bun);
  });

  test("pytest: filter wrapped in quotes so hyphens/spaces don't break -k expr", () => {
    const raw = "test-create-url with space";
    const p = escapeFilterForRunner("pytest", raw);
    expect(p).toBe(`"test-create-url with space"`);
  });

  test("pytest: interior double-quotes are backslash-escaped", () => {
    const raw = `matches "GET /r/:code"`;
    const p = escapeFilterForRunner("pytest", raw);
    expect(p).toBe(`"matches \\"GET /r/:code\\""`);
  });
});
