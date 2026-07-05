import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// PRD_TESTING T0.1 defaults. Overridable per-call so a slow suite can raise
// its own bar without stretching the global default (which the TDD gate uses).
export const DEFAULT_TEST_TIMEOUT_MS  = 120_000;    // 2 min
export const DEFAULT_TEST_OUTPUT_CAP  = 5 * 1024 * 1024; // 5 MB

export interface TestRunResult {
  passed: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
  /** Test framework that was selected for this run (bun, jest, vitest, pytest, npm). */
  runner: string;
  /** Working directory the runner was invoked in — useful when debugging "tests passed but nothing happened". */
  cwd: string;
  /** Counts parsed from the runner output. 0 with passed=true is the silent-success case. */
  passCount: number;
  failCount: number;
  /** Total tests including skipped (= pass + fail + skip). */
  totalCount: number;
  /** Tests that actually executed (= pass + fail). Excludes skipped. The TDD
   * gate treats `executedCount === 0` as "did nothing" regardless of exit
   * code — a suite of all-skipped tests is not a real pass. */
  executedCount: number;
  /** Did we actually execute any tests? false = silent success (0 tests or
   * all skipped), should not be treated as a pass. */
  ranSomething: boolean;
  /** PRD_TESTING T0.1: true when the process hit the timeout kill switch.
   *  Treated as a failure regardless of exit code. */
  timedOut?: boolean;
  /** PRD_TESTING T0.1: true when the output buffer hit the cap; the tail is
   *  replaced with `[...output truncated at N bytes]`. */
  outputTruncated?: boolean;
}

export type Runner = "bun" | "jest" | "vitest" | "pytest" | "go" | "cargo" | "mocha" | "playwright" | "dotnet" | "npm";

export interface RunOpts {
  /** Kill switch — default DEFAULT_TEST_TIMEOUT_MS. Non-positive disables the timer. */
  timeoutMs?: number;
  /** Byte cap on captured stdout+stderr — default DEFAULT_TEST_OUTPUT_CAP. */
  outputCap?: number;
}

/**
 * PRD_TESTING T2.3 — honest runner detection.
 *
 * Old detector was:
 *   1. false-positive on bare pyproject.toml (no pytest installed → runner=pytest → suite reports "no tests")
 *   2. mapped "npm" to `bun run test` — broke node-only repos with no bun installed
 *   3. missing go/cargo/mocha/playwright — silent fall-through to bun
 *
 * New detector prefers strong signals (lockfiles + explicit config files) over
 * weak ones (any `pyproject.toml`), and picks the right invoker per ecosystem.
 * Exported for tests to pin the contract.
 */
export function detectRunner(cwd: string): Runner {
  // Explicit override wins over detection heuristics.
  const override = detectFromOverride(cwd);
  if (override) return override;

  // ─── Node/JS: prefer explicit config, then scripts.test, then lockfile ────
  const jestCfg   = ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs", "jest.config.json"];
  const vitestCfg = ["vitest.config.js", "vitest.config.ts", "vitest.config.mjs", "vitest.config.cjs"];
  const playCfg   = ["playwright.config.js", "playwright.config.ts", "playwright.config.mjs"];
  const mochaCfg  = [".mocharc.js", ".mocharc.cjs", ".mocharc.json", ".mocharc.yml", ".mocharc.yaml"];
  if (jestCfg.some((f) => existsSync(join(cwd, f))))   return "jest";
  if (vitestCfg.some((f) => existsSync(join(cwd, f)))) return "vitest";
  if (playCfg.some((f) => existsSync(join(cwd, f))))   return "playwright";
  if (mochaCfg.some((f) => existsSync(join(cwd, f))))  return "mocha";

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const testScript = pkg.scripts?.["test"] ?? "";
      if (testScript.includes("jest")) return "jest";
      if (testScript.includes("vitest")) return "vitest";
      if (testScript.includes("playwright")) return "playwright";
      if (testScript.includes("mocha")) return "mocha";
      if (testScript.includes("pytest")) return "pytest";
      if (testScript.includes("bun test")) return "bun";
      if (testScript) return "npm"; // will use npm below, not bun
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (deps["jest"])       return "jest";
      if (deps["vitest"])     return "vitest";
      if (deps["playwright"] || deps["@playwright/test"]) return "playwright";
      if (deps["mocha"])      return "mocha";
    } catch {
      // malformed package.json
    }
  }

  // ─── Python: strong pytest signals only ─────────────────────────────────
  if (existsSync(join(cwd, "pytest.ini")))                                return "pytest";
  if (existsSync(join(cwd, "conftest.py")))                               return "pytest";
  if (existsSync(join(cwd, "tox.ini")) && fileContains(join(cwd, "tox.ini"), "pytest")) return "pytest";
  {
    const pypro = join(cwd, "pyproject.toml");
    if (existsSync(pypro) && (fileContains(pypro, "[tool.pytest") || fileContains(pypro, "pytest"))) {
      return "pytest";
    }
  }

  // ─── Go ──────────────────────────────────────────────────────────────────
  if (existsSync(join(cwd, "go.mod"))) return "go";

  // ─── Rust ────────────────────────────────────────────────────────────────
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo";

  // ─── .NET ────────────────────────────────────────────────────────────────
  // Any .csproj/.sln in cwd is a good enough signal for `dotnet test`.
  try {
    const entries = readdirSyncSafe(cwd);
    if (entries.some((n) => n.endsWith(".sln") || n.endsWith(".csproj") || n.endsWith(".fsproj"))) return "dotnet";
  } catch { /* ignore */ }

  // Fall back to bun ONLY when a bun lockfile is present or nothing else
  // was found. Otherwise, prefer npm so a node-only repo doesn't crash on
  // a missing bun binary.
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(pkgPath)) return "npm";
  return "bun";
}

function detectFromOverride(cwd: string): Runner | null {
  // `.agent-trail/runner` file, one word: e.g. "jest". Users can pin the
  // runner when auto-detection guesses wrong (paid-tier: board settings).
  const p = join(cwd, ".agent-trail", "runner");
  if (!existsSync(p)) return null;
  const v = readFileSyncSafe(p).trim().toLowerCase();
  const valid: Runner[] = ["bun", "jest", "vitest", "pytest", "go", "cargo", "mocha", "playwright", "dotnet", "npm"];
  return (valid as string[]).includes(v) ? (v as Runner) : null;
}

function fileContains(path: string, needle: string): boolean {
  try { return readFileSync(path, "utf-8").includes(needle); } catch { return false; }
}
function readFileSyncSafe(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}
function readdirSyncSafe(path: string): string[] {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(path);
  } catch { return []; }
}

// PRD_TESTING T0.4 — escape a raw user filter string so runner pattern
// syntax doesn't broaden or break it. Each runner has different pattern
// rules; we normalize by escaping every metacharacter that carries meaning
// in its syntax and treating the input as a literal substring.
export function escapeFilterForRunner(runner: Runner, filter: string): string {
  switch (runner) {
    case "bun":
    case "jest":
    case "vitest":
    case "mocha":
    case "playwright":
      // These treat the value as a JS regex — escape regex metacharacters.
      return filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    case "go":
      // Go's -run is Go regex — same metaset.
      return filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    case "cargo":
      // Cargo test's filter is a substring of test names; no regex.
      return filter;
    case "dotnet":
      // dotnet test --filter uses "Name~substring" syntax; wrap safely.
      return `Name~${filter.replace(/[|&()]/g, "")}`;
    case "pytest": {
      const inner = filter.replace(/"/g, '\\"');
      return `"${inner}"`;
    }
    case "npm":
      return filter;
  }
}

function runnerCommand(runner: Runner, filter?: string): { cmd: string; args: string[] } {
  const safe = filter ? escapeFilterForRunner(runner, filter) : undefined;
  switch (runner) {
    case "bun":
      return { cmd: "bun", args: safe ? ["test", "--test-name-pattern", safe] : ["test"] };
    case "jest":
      // T2.2 — emit JUnit XML alongside human output for structured parsing.
      return { cmd: "npx", args: [
        "jest", "--no-coverage",
        ...(safe ? ["-t", safe] : []),
        "--reporters=default", "--reporters=jest-junit",
      ] };
    case "vitest":
      return { cmd: "npx", args: [
        "vitest", "run",
        ...(safe ? ["-t", safe] : []),
        "--reporter=default", "--reporter=json", "--outputFile=.vitest-report.json",
      ] };
    case "pytest":
      return { cmd: "pytest", args: [
        "-v",
        ...(safe ? ["-k", safe] : []),
        "--junitxml=.pytest-report.xml",
      ] };
    case "go":
      // `go test ./...` runs the whole module; filter maps to -run.
      return { cmd: "go", args: safe ? ["test", "-run", safe, "-json", "./..."] : ["test", "-json", "./..."] };
    case "cargo":
      // Cargo forwards filter to the test binary after `--`.
      return { cmd: "cargo", args: safe ? ["test", "--", safe] : ["test"] };
    case "mocha":
      return { cmd: "npx", args: safe ? ["mocha", "--grep", safe, "--reporter", "json"] : ["mocha", "--reporter", "json"] };
    case "playwright":
      return { cmd: "npx", args: safe ? ["playwright", "test", "-g", safe, "--reporter=json"] : ["playwright", "test", "--reporter=json"] };
    case "dotnet":
      return { cmd: "dotnet", args: safe ? ["test", "--filter", safe] : ["test"] };
    case "npm":
      // Use whichever package manager the repo has. `npm test` is the
      // universal entry that dispatches to whatever script.test declares.
      return { cmd: "npm", args: ["test", "--silent"] };
  }
}

/**
 * Shared subprocess driver — PRD_TESTING T0.1.
 * Enforces timeout + output cap and returns the captured bytes + terminal
 * signals (timedOut / outputTruncated) so callers can shape their own
 * TestRunResult. Never throws; every path resolves.
 */
interface DriveResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  output: string;
  outputTruncated: boolean;
  timedOut: boolean;
  spawnError: Error | null;
}

function driveSubprocess(
  proc: ChildProcess,
  opts: RunOpts,
): Promise<DriveResult> {
  const cap = opts.outputCap ?? DEFAULT_TEST_OUTPUT_CAP;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let spawnError: Error | null = null;

    const collect = (chunk: Buffer) => {
      if (bytes >= cap) return; // silently drop past-cap bytes
      const remaining = cap - bytes;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        bytes += chunk.length;
        return;
      }
      chunks.push(chunk.subarray(0, remaining));
      bytes += remaining;
      outputTruncated = true;
      // Best-effort: ask the process to stop producing more; the driver still
      // waits for `close` so exit codes stay accurate.
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    };

    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);

    let killTimer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try { proc.kill("SIGTERM"); } catch { /* already gone */ }
        // Belt + braces: SIGKILL after 3s if SIGTERM ignored.
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* */ } }, 3000);
      }, timeoutMs);
    }

    proc.on("error", (err) => { spawnError = err; });

    proc.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      const rawOutput = Buffer.concat(chunks).toString("utf-8");
      const suffix = outputTruncated ? `\n[...output truncated at ${cap} bytes]` : "";
      resolve({
        exitCode: code ?? 1,
        signal,
        output: rawOutput + suffix,
        outputTruncated,
        timedOut,
        spawnError,
      });
    });
  });
}

export async function runTests(
  cwd: string,
  filter?: string,
  opts: RunOpts = {},
): Promise<TestRunResult> {
  const runner = detectRunner(cwd);
  const { cmd, args } = runnerCommand(runner, filter);
  const start = Date.now();

  const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const drv = await driveSubprocess(proc, opts);

  if (drv.spawnError) {
    return {
      passed: false,
      exitCode: 1,
      output: `Failed to run ${cmd}: ${drv.spawnError.message}`,
      durationMs: Date.now() - start,
      runner, cwd,
      passCount: 0, failCount: 0, totalCount: 0,
      executedCount: 0, ranSomething: false,
      timedOut: false, outputTruncated: false,
    };
  }

  const counts = parseCounts(runner, drv.output);
  const executedCount = counts.pass + counts.fail;
  const ranSomething = executedCount > 0;
  // A timed-out run can never be a pass, even if the exit code was 0 due to
  // signal handling quirks — same for anything that hit the output cap.
  const passed = !drv.timedOut && drv.exitCode === 0 && ranSomething && counts.fail === 0;

  return {
    passed,
    exitCode: drv.exitCode,
    output: drv.output,
    durationMs: Date.now() - start,
    runner, cwd,
    passCount: counts.pass, failCount: counts.fail, totalCount: counts.total,
    executedCount, ranSomething,
    timedOut: drv.timedOut,
    outputTruncated: drv.outputTruncated,
  };
}

/**
 * Parse pass / fail / total counts from a test runner's stdout.
 * Each runner has its own summary line; we look for the most reliable one
 * per runner and fall back to scanning the per-test "✓ / ✗" lines.
 *
 * Exported so the unit-test suite can pin the regex contract against
 * fixture stdout from each runner — these regexes break easily and
 * silent drift would re-introduce the false-positive bugs (P1.1 / P1.3).
 */
export function parseCounts(runner: Runner, output: string): { pass: number; fail: number; total: number } {
  let pass = 0;
  let fail = 0;
  let total = 0;

  if (runner === "bun" || runner === "npm") {
    // bun:test summary lines:
    //   " 12 pass"  " 2 skip"  " 0 fail"  "Ran 14 tests across 1 file."
    // Use the canonical "Ran N tests" line for total so skipped tests are counted.
    const passM = output.match(/^\s*(\d+)\s+pass\b/m);
    const failM = output.match(/^\s*(\d+)\s+fail\b/m);
    const ranM  = output.match(/Ran (\d+) tests?\b/m);
    if (passM) pass = Number(passM[1]);
    if (failM) fail = Number(failM[1]);
    if (ranM)  total = Number(ranM[1]);
  } else if (runner === "jest") {
    // Jest:  "Tests:       2 failed, 8 passed, 10 total"
    const sum = output.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/);
    if (sum) {
      fail  = Number(sum[1] ?? 0);
      pass  = Number(sum[2] ?? 0);
      total = Number(sum[3] ?? 0);
    }
  } else if (runner === "vitest") {
    // Vitest ≥1.x:  "Tests  1 failed | 2 skipped | 12 passed (15)"
    // Vitest <1.x:  "Tests  1 failed | 12 passed (13)"
    const sum = output.match(/Tests\s+(?:(\d+)\s+failed\s*\|?\s*)?(?:\d+\s+skipped\s*\|?\s*)?(?:(\d+)\s+passed)\s*\((\d+)\)/);
    if (sum) {
      fail  = Number(sum[1] ?? 0);
      pass  = Number(sum[2] ?? 0);
      total = Number(sum[3] ?? 0);
    }
  } else if (runner === "pytest") {
    // Pytest summary line is wrapped in '=' chars:
    //   "===== 3 passed, 1 skipped, 1 failed in 0.05s ====="
    // Anchor to that wrapper so a verbose run log can't false-match an
    // earlier "X passed" mention in a test name or traceback.
    const summary = output.match(/^=+\s+(.+?)\s+=+\s*$/m);
    const target = summary?.[1] ?? "";
    const passM  = target.match(/(\d+)\s+passed\b/);
    const failM  = target.match(/(\d+)\s+failed\b/);
    const skipM  = target.match(/(\d+)\s+(?:skipped|deselected)\b/);
    if (passM) pass = Number(passM[1]);
    if (failM) fail = Number(failM[1]);
    total = pass + fail + (skipM ? Number(skipM[1]) : 0);
  } else if (runner === "go") {
    // go test -json emits one JSON event per line with Action: pass|fail|skip.
    // Count only Test= (not package-level runs) and only pass/fail/skip.
    for (const line of output.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const ev = JSON.parse(line) as { Action?: string; Test?: string };
        if (!ev.Test) continue;
        if (ev.Action === "pass") pass++;
        else if (ev.Action === "fail") fail++;
      } catch { /* not JSON */ }
    }
    total = pass + fail;
  } else if (runner === "cargo") {
    // cargo test:  "test result: ok. 12 passed; 0 failed; 0 ignored; ..."
    const sum = output.match(/test result:.+?(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/);
    if (sum) {
      pass  = Number(sum[1]);
      fail  = Number(sum[2]);
      total = pass + fail + Number(sum[3]);
    }
  } else if (runner === "mocha") {
    // mocha --reporter json emits one JSON blob to stdout. Try to parse it.
    try {
      const first = output.indexOf("{");
      const last  = output.lastIndexOf("}");
      if (first >= 0 && last > first) {
        const j = JSON.parse(output.slice(first, last + 1)) as {
          stats?: { tests?: number; passes?: number; failures?: number; pending?: number };
        };
        pass  = j.stats?.passes ?? 0;
        fail  = j.stats?.failures ?? 0;
        total = j.stats?.tests ?? (pass + fail + (j.stats?.pending ?? 0));
      }
    } catch { /* fall through to markers */ }
  } else if (runner === "playwright") {
    // playwright --reporter=json emits a big JSON at the end. Try to parse.
    try {
      const first = output.indexOf("{");
      const last  = output.lastIndexOf("}");
      if (first >= 0 && last > first) {
        const j = JSON.parse(output.slice(first, last + 1)) as { stats?: { expected?: number; unexpected?: number; skipped?: number } };
        pass  = j.stats?.expected ?? 0;
        fail  = j.stats?.unexpected ?? 0;
        total = pass + fail + (j.stats?.skipped ?? 0);
      }
    } catch { /* fall through */ }
  } else if (runner === "dotnet") {
    // "Passed! - Failed: 0, Passed: 12, Skipped: 0, Total: 12, ..."
    const sum = output.match(/Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/);
    if (sum) {
      fail  = Number(sum[1]);
      pass  = Number(sum[2]);
      total = Number(sum[4]);
    }
  }

  // Fallback: scan ✓ / ✗ markers if the summary line didn't parse.
  if (pass === 0 && fail === 0 && total === 0) {
    for (const line of output.split("\n")) {
      const t = line.trimStart();
      if (/^[✓✔]\s/.test(t)) pass++;
      else if (/^[✗✕×]\s/.test(t)) fail++;
    }
    total = pass + fail;
  }

  // Ensure total is never less than the sum of parsed pass + fail.
  total = Math.max(total, pass + fail);

  return { pass, fail, total };
}

export async function runCommand(
  command: string,
  cwd: string,
  opts: RunOpts = {},
): Promise<TestRunResult> {
  const start = Date.now();
  const proc = spawn(command, [], {
    cwd, shell: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const drv = await driveSubprocess(proc, opts);
  const base = { runner: "custom", cwd, passCount: 0, failCount: 0, totalCount: 0 };

  if (drv.spawnError) {
    return {
      passed: false, exitCode: 1, output: `Error: ${drv.spawnError.message}`,
      durationMs: Date.now() - start, ...base,
      executedCount: 0, ranSomething: false, timedOut: false, outputTruncated: false,
    };
  }

  // PRD_TESTING T0.2 fix — the previous version wrote `ok ? 1 : 1` which
  // always claimed 1 executed. Now `executedCount` = ok ? 1 : 0 and
  // `ranSomething` reflects whether the command actually completed.
  const ok = !drv.timedOut && drv.exitCode === 0;
  return {
    passed: ok,
    exitCode: drv.exitCode,
    output: drv.output,
    durationMs: Date.now() - start,
    ...base,
    executedCount: ok ? 1 : 0,
    ranSomething: !drv.timedOut,
    timedOut: drv.timedOut,
    outputTruncated: drv.outputTruncated,
  };
}
