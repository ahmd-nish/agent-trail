import { useState, useEffect, useMemo } from "react";
import {
  Play, Check, X, AlertTriangle, Bot, Sparkles, RefreshCw,
  Square, RotateCcw, Bug, ChevronDown, ChevronRight, ChevronUp,
} from "lucide-react";
import type { Task, TestCase, TestCaseHook, AssertionResult } from "../../../../core/src/types/index.ts";
import { api, type UrlSuggestion, type TestRunResult, type DevServerStatus, type DevLogLine } from "../../lib/api.ts";
import { fmtDuration } from "./atoms.tsx";
import { generateCasesForCriterion, blankCase, applyTemplate, findUnresolvedTemplates } from "./generate-test-cases.ts";
import { orderCasesForRun } from "../../lib/test-case-order.ts";
import { evaluateAssertion, type AssertableResponse } from "../../../../core/src/testing/assertions.ts";
import { deriveAssertions } from "../../../../core/src/testing/legacy-assertions.ts";
import { AssertionListEditor } from "./AssertionListEditor.tsx";

const CONNECT_REFUSED_PATTERNS = [
  /econnrefused/i,
  /failed to fetch/i,
  /fetch failed/i,
  /connection refused/i,
  /could not connect/i,
  /unable to connect/i,
  /network error/i,
];

function looksLikeConnRefused(output: string): boolean {
  return CONNECT_REFUSED_PATTERNS.some((rx) => rx.test(output));
}

interface ParsedTest { name: string; passed: boolean; duration?: string; }

interface SuiteResult extends TestRunResult { parsed: ParsedTest[]; }

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const STOPWORDS = new Set([
  "a","an","the","is","are","be","with","without","and","or","of","for","to","from","in","on","at",
  "by","that","this","these","those","then","than","but","also","not","no","yes",
  "returns","return","gives","get","gets","got","does","did","do",
  "should","must","will","may","when","case","cases","test","tests",
]);

// ─── Token matcher: which Claude-written tests cover which criteria ──────────

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[`"',;:!?(){}\[\]]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => w.replace(/[.,]+$/, ""))
    .filter((w) => w.length >= 2);
}

function extractApi(s: string): Array<{ method: string; path: string }> {
  // A criterion can legitimately mention multiple endpoints:
  //   "DELETE /notes/:id returns 204 and subsequent GET /notes/:id returns 404"
  // The matcher should be able to credit a test that covers EITHER hint.
  const hints: Array<{ method: string; path: string }> = [];
  for (const m of s.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\b\s+(\S+)/gi)) {
    hints.push({ method: m[1]!.toUpperCase(), path: m[2]!.replace(/[.,;]+$/, "") });
  }
  return hints;
}

function matchCriterion(criterion: string, tests: ParsedTest[]): ParsedTest | null {
  if (tests.length === 0) return null;
  const apiHints = extractApi(criterion);
  const critTokens = new Set(tokenize(criterion));
  let best: { test: ParsedTest; score: number } | null = null;

  for (const t of tests) {
    const nameLower = t.name.toLowerCase();
    const testTokens = new Set(tokenize(t.name));
    let score = 0;

    // Score against the best-matching API hint — a test that covers ANY of
    // the criterion's endpoints should win over a generic token overlap.
    let bestHintScore = 0;
    for (const hint of apiHints) {
      const hasMethod = nameLower.includes(hint.method.toLowerCase());
      const hasPath = nameLower.includes(hint.path.toLowerCase()) ||
                      nameLower.includes(hint.path.replace(/^\/+/, "").split("/")[0] ?? "");
      if (hasMethod && hasPath) bestHintScore = Math.max(bestHintScore, 100);
      else if (hasMethod || hasPath) bestHintScore = Math.max(bestHintScore, 20);
    }
    score += bestHintScore;

    let overlap = 0;
    for (const tok of critTokens) if (testTokens.has(tok)) overlap++;
    const ratio = critTokens.size > 0 ? overlap / critTokens.size : 0;
    score += overlap * 5 + Math.round(ratio * 30);

    if (overlap < 2 && score < 100) continue;
    if (overlap >= 2 && ratio < 0.4 && score < 100) continue;

    if (!best || score > best.score) best = { test: t, score };
  }
  return best?.test ?? null;
}

/**
 * Parse raw header textarea content into a {Header-Name: value} map.
 * Returns the parsed map plus a list of malformed lines so the UI can warn
 * — silently dropping lines like `Authorization Bearer xxx` (missing colon)
 * is a footgun that wastes test runs.
 */
function parseHeaderLines(raw: string): { headers: Record<string, string>; malformed: string[] } {
  const headers: Record<string, string> = {};
  const malformed: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue; // allow comments
    const sep = line.indexOf(":");
    if (sep <= 0) { malformed.push(line); continue; }
    const name = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!name) { malformed.push(line); continue; }
    headers[name] = value;
  }
  return { headers, malformed };
}

function parseTestOutput(output: string): ParsedTest[] {
  const results: ParsedTest[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trimStart();
    const passM = line.match(/^[✓✔]\s+(.+?)(?:\s+[\[(]([^\])]+)[\])])?$/);
    if (passM) { results.push({ name: passM[1].trim(), passed: true, duration: passM[2] }); continue; }
    const failM = line.match(/^[✗✕×]\s+(.+?)(?:\s+[\[(]([^\])]+)[\])])?$/);
    if (failM) { results.push({ name: failM[1].trim(), passed: false, duration: failM[2] }); continue; }
    // Pytest verbose: "tests/test_foo.py::test_bar PASSED              [50%]"
    // Anchor to a `path::name` shape and require the line to *start* with it
    // so descriptive text like "assertion PASSED but cleanup FAILED" can't
    // register phantom tests.
    const pytestM = line.match(/^(\S+::\S+)\s+(PASSED|FAILED|ERROR)\b/);
    if (pytestM) { results.push({ name: pytestM[1]!, passed: pytestM[2] === "PASSED" }); }
  }
  return results;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props { task: Task; successCriteria: string[]; }

export function TestRunner({ task, successCriteria }: Props) {
  // ── Suite state
  const [suiteRunning, setSuiteRunning] = useState(false);
  const [suiteResult, setSuiteResult] = useState<SuiteResult | null>(null);
  const [rawExpanded, setRawExpanded] = useState(false);

  // ── Persisted test cases (server-backed, optimistic local state)
  const [testCases, setTestCases] = useState<TestCase[]>(task.testCases ?? []);
  useEffect(() => { setTestCases(task.testCases ?? []); }, [task.id, task.testCases]);

  // ── Add-criterion / case UI state
  const [newCriterion, setNewCriterion] = useState("");
  const [criteriaSaving, setCriteriaSaving] = useState(false);
  const [localCriteria, setLocalCriteria] = useState<string[]>(successCriteria);
  useEffect(() => { setLocalCriteria(successCriteria); }, [successCriteria.join("|")]);

  const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set());
  const [busyCases, setBusyCases] = useState<Set<string>>(new Set());
  // Phase 3b: revealed board env map for {{env.X}} substitution. Fetched on
  // mount + when the env tab edits it (via a window event). Values arrive
  // plaintext from the server (?reveal=1) so we can substitute at run time;
  // they live only in memory.
  const [envMap, setEnvMap] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await api.boards.listEnv(task.boardId, true);
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const e of r.entries) map[e.key] = e.value;
        setEnvMap(map);
      } catch { /* board has no env yet — ok */ }
    };
    load();
    const onChange = (ev: Event) => {
      const detail = (ev as CustomEvent<{ boardId?: string }>).detail;
      if (!detail?.boardId || detail.boardId === task.boardId) load();
    };
    window.addEventListener("agent-trail:env-changed", onChange as EventListener);
    return () => { cancelled = true; window.removeEventListener("agent-trail:env-changed", onChange as EventListener); };
  }, [task.boardId]);

  // Phase 3e: tag filter for "Run all". null = run every case; tag name = run
  // only cases bearing that tag. Persisted per-task in sessionStorage.
  const filterKey = `agent-trail.tagFilter.${task.id}`;
  const [tagFilter, setTagFilter] = useState<string | null>(() => {
    try { return sessionStorage.getItem(filterKey); } catch { return null; }
  });
  useEffect(() => {
    try {
      if (tagFilter == null) sessionStorage.removeItem(filterKey);
      else sessionStorage.setItem(filterKey, tagFilter);
    } catch { /* private mode etc. */ }
  }, [tagFilter, filterKey]);

  // ── Base URL discovery
  const [urlSuggestions, setUrlSuggestions] = useState<UrlSuggestion[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  // Set to true after the user picks/types a URL themselves — keeps us from
  // stomping their choice when the dev server status changes later.
  const [baseUrlOverridden, setBaseUrlOverridden] = useState(false);
  useEffect(() => {
    api.tasks.discoverUrls(task.id).then(({ suggestions }) => {
      setUrlSuggestions(suggestions);
      if (suggestions.length > 0 && !baseUrl) setBaseUrl(suggestions[0]!.url);
    }).catch(() => undefined);
  }, [task.id]);

  // ── Dev server status (so the rescue banner can offer one-click start)
  const [devStatus, setDevStatus] = useState<DevServerStatus | null>(null);
  const [devActing, setDevActing] = useState(false);
  const [devLogsOpen, setDevLogsOpen] = useState(false);
  const [devLogs, setDevLogs] = useState<DevLogLine[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => api.dev.status(task.boardId).then((s) => { if (!cancelled) setDevStatus(s); }).catch(() => undefined);
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [task.boardId]);

  // Whenever the dev server is running with a known port, prefer it as the
  // base URL. We don't overwrite a user-typed choice.
  useEffect(() => {
    if (devStatus?.state !== "running" || devStatus.port == null) return;
    const devUrl = `http://localhost:${devStatus.port}`;
    if (!baseUrlOverridden) setBaseUrl(devUrl);
  }, [devStatus?.state, devStatus?.port, baseUrlOverridden]);

  // Merge the live dev URL into the suggestion list (at the top, deduped).
  const effectiveSuggestions = useMemo<UrlSuggestion[]>(() => {
    const list: UrlSuggestion[] = [];
    const seen = new Set<string>();
    if (devStatus?.state === "running" && devStatus.port != null) {
      const url = `http://localhost:${devStatus.port}`;
      list.push({ url, label: "Dev server", source: "running" });
      seen.add(url);
    }
    for (const s of urlSuggestions) {
      if (seen.has(s.url)) continue;
      list.push(s);
      seen.add(s.url);
    }
    return list;
  }, [urlSuggestions, devStatus?.state, devStatus?.port]);

  // Poll logs only while the log strip is open
  useEffect(() => {
    if (!devLogsOpen) return;
    let cancelled = false;
    const tick = () => api.dev.logs(task.boardId, 40).then((lines) => { if (!cancelled) setDevLogs(lines); }).catch(() => undefined);
    tick();
    const id = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [devLogsOpen, task.boardId]);

  async function startDev(): Promise<DevServerStatus | null> {
    setDevActing(true);
    try {
      const next = await api.dev.start(task.boardId);
      setDevStatus(next);
      return next;
    } catch (err) {
      alert(`Could not start dev server: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      setDevActing(false);
    }
  }

  async function stopDev(): Promise<void> {
    setDevActing(true);
    try {
      const r = await api.dev.stop(task.boardId);
      setDevStatus(r.status);
    } finally {
      setDevActing(false);
    }
  }

  async function restartDev(): Promise<void> {
    setDevActing(true);
    try {
      await api.dev.stop(task.boardId);
      await new Promise((r) => setTimeout(r, 300));
      const next = await api.dev.start(task.boardId);
      setDevStatus(next);
    } catch (err) {
      alert(`Could not restart dev server: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDevActing(false);
    }
  }

  async function startDevAndRetry(caseId: string) {
    const next = await startDev();
    if (!next || next.state !== "running") return;
    // Give the dev server ~2s to bind, then re-run the case
    await new Promise((r) => setTimeout(r, 2000));
    await runCase(caseId);
  }

  /**
   * Dispatch Claude to write tests for this task's criteria when the suite is
   * empty. Polls for completion, then auto-reruns the suite so the user sees
   * the new tests light up the coverage matrix.
   */
  const [writingTests, setWritingTests] = useState<{ taskId: string; title: string } | null>(null);
  async function dispatchClaudeToWriteTests() {
    if (writingTests) return;
    if (localCriteria.length === 0) {
      alert("Add at least one success criterion first — Claude needs something to test against.");
      return;
    }
    try {
      const description = [
        `Write an automated test suite for **${task.title}** in the board's implementation directory (see board.implementation_dir).`,
        "",
        "## Criteria to cover",
        ...localCriteria.map((c, i) => `${i + 1}. ${c}`),
        "",
        "## Where to put the tests",
        "- Create a `tests/` directory under the implementation root, or place `*.test.{ts,js}` next to the route files.",
        "- Name each test so the criterion text is recognizable — agent-trail's coverage matcher uses token overlap between test name and criterion text.",
        "  - Good: `test(\"POST /notes with valid title+body returns 201 with tags []\", …)`",
        "  - Bad:  `test(\"create works\", …)`",
        "",
        "## How the tests should run",
        "- Use the runtime already configured in `package.json` (likely `bun:test`).",
        "- Each test makes the actual HTTP call against an in-process server (`new Bun.Server`, `app.fetch`, supertest-style, etc.) — don't require the dev server to be running.",
        "- Reset state between tests so they're independent (clear the DB, reseed if needed).",
        "",
        "## Do NOT",
        "- Don't modify the implementation. The implementation should already match the criteria; tests just verify.",
        "- Don't add heavyweight test dependencies if `bun:test` is sufficient.",
        "- Don't write a single mega-test — one criterion = one test (or a small `describe` block).",
        "",
        "## When you're done",
        "Run the test suite locally once to confirm it executes. The user will re-run from the agent-trail UI.",
      ].join("\n");

      const created = await api.tasks.create(task.boardId, {
        title: `Write tests for: ${task.title}`,
        description,
        status: "ready",
        priority: "high",
        assignee: "claude-code",
        tddEnabled: false,
        tddPhase: "implement_only",
        successCriteria: [
          `An automated test exists for each of the ${localCriteria.length} criterion of the parent task`,
          "The test suite runs cleanly (exit code 0, all tests passing) when invoked",
          "Each test's name contains enough of the criterion's words that agent-trail's coverage matcher will pair them up",
        ],
        epic: task.epic ?? undefined,
        sprint: task.sprint ?? undefined,
        dependsOn: [task.id],
      } as never);

      await api.tasks.execute(created.id);
      setWritingTests({ taskId: created.id, title: created.title });
    } catch (err) {
      alert(`Could not dispatch test-writing task: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Poll the test-writer task; when it finishes (in_review/done) auto-rerun the suite.
  useEffect(() => {
    if (!writingTests) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await api.tasks.list(task.boardId);
        const fresh = list.find((t) => t.id === writingTests.taskId);
        if (!fresh || cancelled) return;
        if (fresh.status === "in_review" || fresh.status === "done") {
          setWritingTests(null);
          // Wait a beat so any final file writes settle, then re-run the suite.
          setTimeout(() => { if (!cancelled) runSuite(); }, 800);
        }
        if (fresh.status === "blocked") {
          // Test-writer task hit ask_human or failed — let the user investigate.
          setWritingTests(null);
        }
      } catch { /* keep polling */ }
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(id); };
  }, [writingTests?.taskId, task.boardId]);

  /**
   * Dispatch Claude to investigate why the dev server is misbehaving and fix it.
   * Captures the current state + recent logs so the agent gets full context.
   */
  const [dispatchingFix, setDispatchingFix] = useState(false);
  async function dispatchClaudeFix(reason: "unreachable" | "crashed" | "wont_start"): Promise<void> {
    if (dispatchingFix) return;
    setDispatchingFix(true);
    try {
      // Pull fresh logs so we don't rely on whatever the popover happens to have polled.
      const logs = await api.dev.logs(task.boardId, 60).catch(() => [] as DevLogLine[]);
      const logTail = logs.length === 0
        ? "(no log lines captured)"
        : logs.map((l) => `[${l.stream}] ${l.text}`).join("\n");

      const port = devStatus?.port ?? "?";
      const cmd = devStatus?.command ?? "(none)";
      const cwd = devStatus?.cwd ?? "(unknown)";

      const reasonLine =
        reason === "unreachable"
          ? `The process is running but nothing is listening on :${port}.`
          : reason === "crashed"
          ? `The dev server crashed (exit ${devStatus?.lastExitCode ?? "?"}).`
          : `The dev server failed to start.`;

      const title =
        reason === "unreachable" ? `Fix dev server: port ${port} not responding`
        : reason === "crashed" ? `Fix dev server: crashed (exit ${devStatus?.lastExitCode ?? "?"})`
        : `Fix dev server: won't start`;

      const description = [
        reasonLine,
        "",
        "## Context",
        `- Board: ${task.boardId}`,
        `- Implementation dir: ${cwd}`,
        `- Configured dev command: \`${cmd}\``,
        `- Configured port: ${port}`,
        `- Parent task: ${task.title} (${task.id})`,
        "",
        "## Recent stdout/stderr",
        "```",
        logTail.slice(-3000),
        "```",
        "",
        "## What to do",
        "1. Inspect the implementation in the directory above.",
        "2. Find the entry point that should start an HTTP server on the configured port.",
        "3. If the entry point is missing, broken, or listening on the wrong port — fix it.",
        "4. If the configured command itself is wrong (e.g. doesn't actually start a server), point it out clearly in your response so the user can update Board settings.",
        "5. Do NOT change `agent-trail` itself. The fix lives in the implementation directory only.",
      ].join("\n");

      const successCriteria = [
        `A TCP connection to localhost:${port} succeeds within 5 seconds of running the dev command`,
        `The dev command prints a startup message indicating it is listening on the correct port`,
        `Subsequent HTTP requests to the configured endpoints return the expected status codes`,
      ];

      const created = await api.tasks.create(task.boardId, {
        title,
        description,
        status: "ready",
        priority: "high",
        assignee: "claude-code",
        tddEnabled: false,
        tddPhase: "implement_only",
        successCriteria,
        epic: task.epic ?? undefined,
        sprint: task.sprint ?? undefined,
        dependsOn: [task.id],
      } as never);

      const runNow = confirm(
        `Created task "${created.title}".\n\n` +
        `Run it now? Claude will edit files in:\n${cwd}`,
      );
      if (runNow) {
        await api.tasks.execute(created.id);
      }
    } catch (err) {
      alert(`Could not dispatch Claude: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDispatchingFix(false);
    }
  }

  // ── Derived: coverage matrix
  const coverage = useMemo(() => {
    const tests = suiteResult?.parsed ?? [];
    const used = new Set<ParsedTest>();
    return localCriteria.map((c) => {
      const match = matchCriterion(c, tests.filter((t) => !used.has(t)));
      if (match) used.add(match);
      return { criterion: c, match };
    });
  }, [localCriteria, suiteResult]);

  const orphanTests = useMemo(() => {
    const tests = suiteResult?.parsed ?? [];
    const claimed = new Set(coverage.filter((c) => c.match).map((c) => c.match!.name));
    return tests.filter((t) => !claimed.has(t.name));
  }, [suiteResult, coverage]);

  const casesByCriterion = useMemo(() => {
    const map = new Map<number, TestCase[]>();
    for (const tc of testCases) {
      if (!map.has(tc.criterionIndex)) map.set(tc.criterionIndex, []);
      map.get(tc.criterionIndex)!.push(tc);
    }
    return map;
  }, [testCases]);

  // ── Persistence helper

  async function persistCases(next: TestCase[]): Promise<void> {
    setTestCases(next); // optimistic
    try {
      await api.tasks.update(task.id, { testCases: next } as never);
    } catch (err) {
      alert(`Could not save test cases: ${err instanceof Error ? err.message : String(err)}`);
      // refetch to roll back
      api.tasks.list(task.boardId).then((ts) => {
        const fresh = ts.find((t) => t.id === task.id);
        if (fresh) setTestCases(fresh.testCases ?? []);
      }).catch(() => undefined);
    }
  }

  // ── Actions: suite

  async function runSuite() {
    setSuiteRunning(true);
    setSuiteResult(null);
    setRawExpanded(false);
    try {
      const r = await api.tasks.test(task.id);
      setSuiteResult({ ...r, parsed: parseTestOutput(r.output) });
    } catch {
      setSuiteResult({
        passed: false, exitCode: 1, output: "Failed to reach test runner.", durationMs: 0,
        runner: "unknown", cwd: "", passCount: 0, failCount: 0, totalCount: 0, executedCount: 0, ranSomething: false,
        parsed: [],
      });
    } finally {
      setSuiteRunning(false);
    }
  }

  // ── Actions: criteria

  async function addCriterion() {
    const text = newCriterion.trim();
    if (!text || criteriaSaving) return;
    setCriteriaSaving(true);
    const nextCriteria = [...localCriteria, text];
    setLocalCriteria(nextCriteria);
    setNewCriterion("");
    try {
      await api.tasks.update(task.id, { successCriteria: nextCriteria });
    } catch (err) {
      setLocalCriteria(localCriteria);
      alert(`Could not add criterion: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCriteriaSaving(false);
    }
  }

  // ── Actions: test cases

  async function generateForCriterion(idx: number) {
    const criterion = localCriteria[idx];
    if (!criterion) return;
    const generated = generateCasesForCriterion(criterion, idx);
    await persistCases([...testCases, ...generated]);
    // Expand newly created cases by default
    setExpandedCases((prev) => {
      const next = new Set(prev);
      for (const c of generated) next.add(c.id);
      return next;
    });
  }

  /**
   * Wipe all cases for a criterion and re-derive them from the criterion text.
   * Used when the heuristic got the method/path wrong, or when the user wants
   * to start over after manual edits diverged.
   */
  async function regenerateForCriterion(idx: number) {
    const criterion = localCriteria[idx];
    if (!criterion) return;
    const existing = casesByCriterion.get(idx) ?? [];
    if (existing.length > 0) {
      const ok = confirm(`Replace ${existing.length} existing case${existing.length === 1 ? "" : "s"} for this criterion with freshly-generated ones?`);
      if (!ok) return;
    }
    const generated = generateCasesForCriterion(criterion, idx);
    // Keep all cases NOT belonging to this criterion, plus the new ones.
    const kept = testCases.filter((c) => c.criterionIndex !== idx);
    await persistCases([...kept, ...generated]);
    setExpandedCases((prev) => {
      const next = new Set(prev);
      for (const c of generated) next.add(c.id);
      return next;
    });
  }

  /**
   * Build a rich bug-ticket task from a failed case. `mode` controls whether
   * the task is set to `ready` (and immediately executed) or `backlog`.
   */
  const [raisingBug, setRaisingBug] = useState<Set<string>>(new Set());
  async function raiseBugFromCase(caseId: string, mode: "fix-now" | "backlog") {
    const tc = testCases.find((c) => c.id === caseId);
    if (!tc) return;
    const criterion = localCriteria[tc.criterionIndex] ?? "(unknown criterion)";
    const r = tc.lastRun;
    if (!r) {
      alert("Run the case first so the bug ticket can include the actual failure.");
      return;
    }

    setRaisingBug((s) => new Set(s).add(caseId));
    try {
      // Pull recent dev-server logs so Claude can correlate the failure.
      const devLogs = await api.dev.logs(task.boardId, 30).catch(() => [] as DevLogLine[]);
      const devTail = devLogs.length === 0
        ? "(no dev server logs)"
        : devLogs.slice(-15).map((l) => `[${l.stream}] ${l.text}`).join("\n");

      const verb = tc.kind === "api"
        ? `${tc.method} ${tc.path}`
        : `$ ${tc.command}`;

      const title = `Bug: ${verb} — expected ${
        tc.kind === "api" ? tc.expectedStatus : `exit ${tc.expectedExitCode}`
      }, got ${
        r.actualStatus ?? r.actualExitCode ?? "error"
      }`;

      const description = [
        `A test case for **${task.title}** failed.`,
        "",
        "## Criterion",
        criterion,
        "",
        "## Test case",
        tc.kind === "api"
          ? [
              `- Method: \`${tc.method}\``,
              `- Path: \`${tc.path}\``,
              `- Body: \`${tc.body ?? "(none)"}\``,
              `- Headers: \`${tc.headers ?? "(none)"}\``,
              `- Expected status: \`${tc.expectedStatus}\``,
              tc.expectedBodyContains ? `- Expected body contains: \`${tc.expectedBodyContains}\`` : null,
            ].filter(Boolean).join("\n")
          : [
              `- Command: \`${tc.command}\``,
              `- Expected exit code: ${tc.expectedExitCode ?? 0}`,
            ].join("\n"),
        "",
        "## Actual result",
        r.actualStatus !== undefined ? `- HTTP status: **${r.actualStatus}** (expected ${tc.expectedStatus})` : "",
        r.actualExitCode !== undefined ? `- Exit code: **${r.actualExitCode}** (expected ${tc.expectedExitCode ?? 0})` : "",
        "- Duration: " + r.durationMs + " ms",
        "- Ran at: " + r.ranAt,
        "",
        "### Assertion breakdown",
        ...(r.assertions ?? []).map((a) => `- ${a.passed ? "✓" : "✗"} **${a.label}**: expected \`${a.expected}\`, got \`${a.actual}\``),
        "",
        "### Response / output",
        "```",
        r.output.slice(0, 2000),
        "```",
        "",
        "## Parent task context",
        `- Task: ${task.title} (${task.id})`,
        `- Component hint: ${task.component ?? "(none)"}`,
        `- Implementation dir: (see board.implementation_dir)`,
        "",
        "## Recent dev server logs",
        "```",
        devTail,
        "```",
        "",
        "## What to do",
        "1. Read the implementation files referenced above (or `ls` the impl dir).",
        "2. Make the failing test case pass — adjust the implementation to match the criterion exactly.",
        "3. Do NOT change the test case itself; the criterion is the source of truth.",
        "4. After your fix, the user will re-run the case from the task panel to verify.",
      ].filter((x) => x !== "").join("\n");

      const created = await api.tasks.create(task.boardId, {
        title,
        description,
        status: mode === "fix-now" ? "ready" : "backlog",
        priority: mode === "fix-now" ? "high" : "medium",
        assignee: "claude-code",
        tddEnabled: false,
        tddPhase: "implement_only",
        successCriteria: [
          `${verb} returns ${tc.expectedStatus ?? `exit ${tc.expectedExitCode ?? 0}`} when the implementation is correct`,
          ...(tc.expectedBodyContains ? [`Response body contains "${tc.expectedBodyContains}"`] : []),
        ],
        epic: task.epic ?? undefined,
        sprint: task.sprint ?? undefined,
        component: task.component ?? undefined,
        dependsOn: [task.id],
      } as never);

      if (mode === "fix-now") {
        await api.tasks.execute(created.id);
        alert(`Bug task created and dispatched:\n${created.title}\n\nWatch it on the board.`);
      } else {
        alert(`Added to backlog:\n${created.title}\n\nIt'll show up in the Backlog column.`);
      }
    } catch (err) {
      alert(`Could not create bug ticket: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRaisingBug((s) => { const n = new Set(s); n.delete(caseId); return n; });
    }
  }

  async function generateForAllUncovered() {
    const additions: TestCase[] = [];
    for (let i = 0; i < localCriteria.length; i++) {
      if (coverage[i]?.match) continue;
      if (casesByCriterion.get(i)?.length) continue;
      additions.push(...generateCasesForCriterion(localCriteria[i]!, i));
    }
    if (additions.length === 0) return;
    await persistCases([...testCases, ...additions]);
  }

  async function addManualCase(idx: number, kind: "api" | "shell" = "api") {
    const c = blankCase(idx, kind);
    await persistCases([...testCases, c]);
    setExpandedCases((prev) => new Set(prev).add(c.id));
  }

  async function deleteCase(id: string) {
    await persistCases(testCases.filter((tc) => tc.id !== id));
  }

  async function updateCase(id: string, patch: Partial<TestCase>) {
    await persistCases(testCases.map((tc) => (tc.id === id ? { ...tc, ...patch } : tc)));
  }

  function resolvedUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const base = baseUrl.trim().replace(/\/$/, "");
    return base ? `${base}${path.startsWith("/") ? "" : "/"}${path}` : path;
  }

  /**
   * Execute ONE attempt of a test case. Returned shape is exactly what gets
   * persisted into `lastRun` (minus `attempts` which the retry wrapper sets).
   * Never throws — wraps inner errors into a failing result.
   */
  async function attemptCase(tc: TestCase): Promise<{
    passed: boolean;
    durationMs: number;
    actualStatus?: number;
    actualExitCode?: number;
    output: string;
    assertions: AssertionResult[];
    responseJson?: unknown;
    timedOut?: boolean;
  }> {
    try {
      if (tc.kind === "api") {
        // Sequence case: pull the prior case's parsed response and substitute
        // {{prev.<key>}} placeholders in path + body. responseJson is the
        // canonical source (parsed at run time, untruncated). Old cases
        // without responseJson fall back to parsing the output string.
        const ctx: Record<string, unknown> = {};
        if (tc.dependsOnCaseId) {
          const prior = testCases.find((c) => c.id === tc.dependsOnCaseId);
          const priorJson = prior?.lastRun?.responseJson;
          if (priorJson && typeof priorJson === "object" && !Array.isArray(priorJson)) {
            Object.assign(ctx, priorJson as Record<string, unknown>);
          } else {
            const priorOut = prior?.lastRun?.output ?? "";
            const jsonStart = priorOut.indexOf("{");
            if (jsonStart >= 0) {
              try { Object.assign(ctx, JSON.parse(priorOut.slice(jsonStart))); }
              catch { /* prior output isn't JSON or was truncated */ }
            }
          }
        }
        const tplCtx = { prev: ctx, env: envMap };
        const path = applyTemplate(tc.path ?? "/", tplCtx, "url");
        const url = resolvedUrl(path);
        const renderedBody = tc.body ? applyTemplate(tc.body, tplCtx, "json") : "";
        const renderedHeaders = applyTemplate(tc.headers ?? "", tplCtx, "raw");
        const hasBody = renderedBody.trim().length > 0;
        const { headers, malformed: malformedHeaders } = parseHeaderLines(renderedHeaders);
        // Collect any {{prev.X}} / {{env.X}} placeholders that didn't resolve
        // — surfaces silently-sent-as-literal substitutions to the user.
        const unresolved = [
          ...findUnresolvedTemplates(tc.path ?? "/", tplCtx),
          ...findUnresolvedTemplates(tc.body ?? "", tplCtx),
          ...findUnresolvedTemplates(tc.headers ?? "", tplCtx),
        ];
        if (hasBody && !["GET", "HEAD"].includes(tc.method ?? "GET") && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        const r = await api.tasks.apiRequest(task.id, {
          method: tc.method ?? "GET", url,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          body: hasBody ? renderedBody : undefined,
          timeoutMs: tc.timeoutMs,
        });
        const actualStatus = r.status ?? 0;
        const assertions: AssertionResult[] = [];

        let responseJson: unknown = undefined;
        if (!r.error && r.body) {
          const trimmed = r.body.trim();
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try { responseJson = JSON.parse(r.body); }
            catch { /* not JSON */ }
          }
        }

        if (r.error) {
          const label = r.timedOut ? "Timeout" : "Connection";
          assertions.push({ label, passed: false, expected: r.timedOut ? `< ${tc.timeoutMs ?? 30000}ms` : "HTTP response", actual: r.error });
        } else {
          const lowerHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(r.headers ?? {})) lowerHeaders[k.toLowerCase()] = v;
          const response: AssertableResponse = {
            status: r.status,
            headers: lowerHeaders,
            body: r.body,
            bodyJson: responseJson,
            durationMs: r.durationMs,
          };
          for (const a of deriveAssertions(tc)) {
            assertions.push(evaluateAssertion(a, response));
          }
        }

        const passed = assertions.length > 0 && assertions.every((a) => a.passed);
        const headerWarning = malformedHeaders.length > 0
          ? `⚠ Ignored ${malformedHeaders.length} malformed header line${malformedHeaders.length === 1 ? "" : "s"} (missing ':'):\n${malformedHeaders.map((l) => `  ${l}`).join("\n")}\n\n`
          : "";
        const unresolvedWarning = unresolved.length > 0
          ? `⚠ Sent request with unresolved placeholders (set them in board env or run a prior case first):\n${[...new Set(unresolved)].map((t) => `  ${t}`).join("\n")}\n\n`
          : "";
        const output = r.error
          ? `${unresolvedWarning}${headerWarning}Request failed: ${r.error}`
          : `${unresolvedWarning}${headerWarning}${actualStatus} ${r.statusText ?? ""}\n${(r.body ?? "").slice(0, 800)}`;
        return {
          passed,
          durationMs: r.durationMs,
          actualStatus,
          output,
          assertions,
          responseJson,
          timedOut: r.timedOut,
        };
      } else {
        const r = await api.tasks.customRun(task.id, { command: tc.command ?? "" });
        const response: AssertableResponse = {
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          body: r.output,
        };
        const assertions: AssertionResult[] = deriveAssertions(tc).map((a) =>
          evaluateAssertion(a, response),
        );
        const passed = assertions.length > 0 && assertions.every((a) => a.passed);
        return {
          passed,
          durationMs: r.durationMs,
          actualExitCode: r.exitCode,
          output: r.output,
          assertions,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        durationMs: 0,
        output: msg,
        assertions: [{ label: "Runner", passed: false, expected: "completed run", actual: msg }],
      };
    }
  }

  /**
   * Execute a setup/teardown hook. Returns { ok, summary } — failures are
   * surfaced into the case output but never throw.
   */
  async function runHook(hook: TestCaseHook): Promise<{ ok: boolean; summary: string }> {
    const tplCtx = { env: envMap };
    try {
      if (hook.kind === "api") {
        const path = applyTemplate(hook.path ?? "/", tplCtx, "url");
        const url = resolvedUrl(path);
        const body = hook.body ? applyTemplate(hook.body, tplCtx, "json") : "";
        const hasBody = body.trim().length > 0;
        const { headers } = parseHeaderLines(applyTemplate(hook.headers ?? "", tplCtx, "raw"));
        if (hasBody && !["GET", "HEAD"].includes(hook.method ?? "GET") && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        const r = await api.tasks.apiRequest(task.id, {
          method: hook.method ?? "GET", url,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          body: hasBody ? body : undefined,
          timeoutMs: 15000,
        });
        const label = hook.label ?? `${hook.method ?? "GET"} ${hook.path ?? "/"}`;
        if (r.error) return { ok: false, summary: `[hook] ${label} — ${r.error}` };
        const ok = r.status !== undefined && r.status >= 200 && r.status < 400;
        return { ok, summary: `[hook] ${label} → ${r.status ?? "?"}` };
      } else {
        const r = await api.tasks.customRun(task.id, { command: applyTemplate(hook.command ?? "", tplCtx, "raw") });
        const label = hook.label ?? `$ ${hook.command ?? ""}`;
        return { ok: r.exitCode === 0, summary: `[hook] ${label} → exit ${r.exitCode}` };
      }
    } catch (err) {
      return { ok: false, summary: `[hook] error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function runCase(id: string) {
    const tc = testCases.find((c) => c.id === id);
    if (!tc) return;
    setBusyCases((s) => new Set(s).add(id));
    try {
      // Setup: any failure halts the case before assertion evaluation.
      const hookOutput: string[] = [];
      for (const hook of tc.setup ?? []) {
        const h = await runHook(hook);
        hookOutput.push(h.summary);
        if (!h.ok) {
          const ranAt = new Date().toISOString();
          await persistCases(testCases.map((c) => c.id === id ? {
            ...c,
            lastRun: {
              passed: false,
              durationMs: 0,
              output: `${hookOutput.join("\n")}\n\n⚠ Setup hook failed — case skipped.`,
              ranAt,
              attempts: 1,
              assertions: [{ label: "Setup", passed: false, expected: "all setup hooks ok", actual: h.summary }],
            },
          } : c));
          return;
        }
      }

      // Main attempt loop (timeout + retry handled inside attemptCase + here).
      const maxAttempts = 1 + Math.max(0, tc.retry?.count ?? 0);
      const backoffMs = Math.max(0, tc.retry?.backoffMs ?? 0);
      let result: Awaited<ReturnType<typeof attemptCase>> | null = null;
      let attempts = 0;
      for (let i = 0; i < maxAttempts; i++) {
        attempts = i + 1;
        result = await attemptCase(tc);
        if (result.passed) break;
        if (i < maxAttempts - 1 && backoffMs > 0) {
          await new Promise((res) => setTimeout(res, backoffMs));
        }
      }
      const final = result!;

      // Teardown: runs regardless of pass/fail. Failures append to output
      // but don't flip the main passed flag — the user already has the
      // signal from setup/main.
      for (const hook of tc.teardown ?? []) {
        const h = await runHook(hook);
        hookOutput.push(h.summary);
      }

      const ranAt = new Date().toISOString();
      const output = hookOutput.length > 0
        ? `${hookOutput.join("\n")}\n\n${final.output}`
        : final.output;
      await persistCases(testCases.map((c) => c.id === id
        ? { ...c, lastRun: { ...final, output, ranAt, attempts } }
        : c));
      // Phase 3d: append to per-case run history. Fire-and-forget — failures
      // here shouldn't block the user (the result is already in lastRun).
      api.tasks
        .recordRun(task.id, id, {
          passed: final.passed,
          durationMs: final.durationMs,
          attempts,
          output: output.slice(0, 8000),
          assertions: final.assertions,
          ranAt,
        })
        .catch(() => { /* history is best-effort */ });
      // Notify the sparkline to refresh.
      window.dispatchEvent(new CustomEvent("agent-trail:case-ran", { detail: { caseId: id } }));
    } finally {
      setBusyCases((s) => { const next = new Set(s); next.delete(id); return next; });
    }
  }

  // Union of tags across all cases — drives the filter dropdown options.
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const c of testCases) for (const t of c.tags ?? []) s.add(t);
    return [...s].sort();
  }, [testCases]);

  // Cases the current filter would actually run. `null` filter = all cases.
  const filteredCases = useMemo(() => {
    if (!tagFilter) return testCases;
    return testCases.filter((c) => (c.tags ?? []).includes(tagFilter));
  }, [testCases, tagFilter]);

  async function runAllCases() {
    // PRD_TESTING T0.5 — respect dependsOnCaseId order, auto-include filtered-out
    // dependencies, refuse to run when a dependency has been deleted from under us.
    const { ordered, autoIncludedIds, danglingRefs, hasCycle } = orderCasesForRun(testCases, filteredCases);
    if (danglingRefs.length > 0) {
      const missing = danglingRefs.map((d) => d.missingDepId.slice(0, 8)).join(", ");
      alert(`Cannot run all: ${danglingRefs.length} case(s) reference deleted dependencies (${missing}). Fix or clear the dependsOnCaseId first.`);
      return;
    }
    if (hasCycle) {
      alert("Cannot run all: a cycle was detected in dependsOnCaseId. Break the cycle first.");
      return;
    }
    if (autoIncludedIds.length > 0) {
      console.info(`[test-runner] auto-including ${autoIncludedIds.length} dependency case(s) excluded by the tag filter.`);
    }
    for (const tc of ordered) {
      // eslint-disable-next-line no-await-in-loop
      await runCase(tc.id);
    }
  }

  // ── Render

  const allCases = testCases;
  const totalRun = allCases.filter((c) => c.lastRun).length;
  const totalPass = allCases.filter((c) => c.lastRun?.passed).length;
  const uncoveredCount = coverage.filter((c) => !c.match).length;
  const uncoveredWithoutCases = coverage.reduce((n, c, i) => n + (!c.match && !casesByCriterion.get(i)?.length ? 1 : 0), 0);

  return (
    <div className="flex flex-col gap-5">

      {/* ── Suite run ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={runSuite}
            disabled={suiteRunning}
            className="claw-btn primary flex items-center gap-1.5"
            style={{ fontSize: 11, padding: "5px 14px", opacity: suiteRunning ? 0.6 : 1 }}
          >
            {suiteRunning
              ? <><span className="w-3 h-3 rounded-full border-2 animate-spin shrink-0" style={{ borderColor: "var(--green-line)", borderTopColor: "var(--green)" }} /> Running…</>
              : <><Play size={11} /> Run Claude's test suite</>}
          </button>
          {suiteResult && (() => {
            if (!suiteResult.ranSomething) {
              return <span className="text-xs font-medium text-amber-400 flex items-center gap-1"><AlertTriangle size={11} /> No tests in suite · {fmtDuration(suiteResult.durationMs)}</span>;
            }
            return (
              <span className={`text-xs font-medium ${suiteResult.passed ? "text-emerald-400" : "text-red-400"}`}>
                {suiteResult.passed ? <Check size={11} className="inline" /> : <X size={11} className="inline" />} {suiteResult.passCount}/{suiteResult.totalCount} suite tests passed · {fmtDuration(suiteResult.durationMs)}
              </span>
            );
          })()}
        </div>

        {suiteResult && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 flex-wrap text-[10px] text-slate-500">
              <span>Runner: <span className="text-slate-400 font-mono">{suiteResult.runner}</span></span>
              <span className="text-slate-700">·</span>
              <span title={suiteResult.cwd}>cwd: <span className="text-slate-400 font-mono">{suiteResult.cwd ? suiteResult.cwd.replace(/^.*\//, "…/") : "(unknown)"}</span></span>
              {suiteResult.ranSomething && <><span className="text-slate-700">·</span><span>{suiteResult.totalCount} tests</span></>}
            </div>
            {suiteResult.usedFallbackCwd && (
              <div className="rounded-lg border border-red-800/50 bg-red-950/30 p-3">
                <p className="text-xs font-semibold text-red-300 mb-1 flex items-center gap-1.5"><AlertTriangle size={12} /> Tests ran against agent-trail itself, not your task</p>
                <p className="text-[11px] text-red-200/80">This board has no implementation directory set. Open Board settings and set one.</p>
              </div>
            )}
            {!suiteResult.ranSomething && !suiteResult.usedFallbackCwd && (
              <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 p-3 flex flex-col gap-2">
                <p className="text-xs font-semibold text-amber-300 flex items-center gap-1.5"><AlertTriangle size={12} /> Claude didn't write any tests in {suiteResult.cwd.replace(/^.*\//, "…/")}</p>
                <p className="text-[11px] text-amber-200/80">
                  Two ways forward — ask Claude to write a real test suite, or just verify each criterion manually from the dashboard below.
                </p>
                <div className="flex items-center gap-2 flex-wrap mt-1">
                  <button
                    onClick={dispatchClaudeToWriteTests}
                    disabled={!!writingTests}
                    className="text-[11px] px-3 py-1.5 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-50 text-white font-medium flex items-center gap-1.5"
                    title="Create a high-priority task for Claude to write a bun:test suite covering every criterion, then auto-rerun the suite when it's done"
                  >
                    {writingTests
                      ? <><span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" /> Claude is writing tests…</>
                      : <><Bot size={12} /> Ask Claude to write tests</>}
                  </button>
                  {writingTests && (
                    <span className="text-[10px] text-amber-300/70">
                      will re-run the suite automatically when "{writingTests.title}" completes
                    </span>
                  )}
                </div>
              </div>
            )}
            <button onClick={() => setRawExpanded((x) => !x)} className="text-[10px] text-slate-600 hover:text-slate-400 text-left self-start">
              {rawExpanded ? "▲ Hide raw output" : "▼ Show raw output"}
            </button>
            {rawExpanded && (
              <pre className="text-[10px] font-mono text-slate-400 bg-slate-950/60 border border-slate-800 rounded p-3 whitespace-pre-wrap max-h-48 overflow-y-auto">
                {suiteResult.output || "(no output)"}
              </pre>
            )}
          </div>
        )}
      </section>

      {/* ── Inline dev server status bar (always visible above test cases) ── */}
      {(() => {
        const state = devStatus?.state ?? "stopped";
        const port = devStatus?.port ?? null;
        const cmd = devStatus?.command ?? null;
        const noConfig = state === "stopped" && !cmd;
        // Treat "process up but port unreachable" as a distinct sub-state — it's
        // a common gotcha (wrong command, server still binding, wrong port set).
        const unreachable = state === "running" && devStatus?.portReachable === false;

        const stateMeta = {
          running: unreachable
            ? { dot: "bg-amber-400", text: "text-amber-300", label: `Running but :${port} not responding` }
            : { dot: "bg-emerald-500", text: "text-emerald-300", label: "Running" },
          starting: { dot: "bg-amber-400 animate-pulse", text: "text-amber-300", label: "Starting…" },
          stopped: { dot: "bg-slate-500", text: "text-slate-400", label: noConfig ? "Not configured" : "Stopped" },
          crashed: { dot: "bg-red-500", text: "text-red-300", label: "Crashed" },
        }[state];

        const containerCls =
          state === "running" && !unreachable ? "border-emerald-800/40 bg-emerald-950/10"
          : state === "running" && unreachable ? "border-amber-800/40 bg-amber-950/10"
          : state === "crashed" ? "border-red-800/40 bg-red-950/10"
          : state === "starting" ? "border-amber-800/40 bg-amber-950/10"
          : "border-slate-700 bg-slate-800/40";

        return (
          <section className={`rounded-lg border ${containerCls} flex flex-col`}>
            <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
              <span className={`w-2 h-2 rounded-full ${stateMeta.dot}`} />
              <span className={`text-xs font-semibold ${stateMeta.text}`}>
                Dev server: {stateMeta.label}
              </span>
              {state === "running" && port != null && (
                <span className="text-[10px] font-mono text-emerald-400">:{port}</span>
              )}
              {state === "running" && devStatus?.uptimeMs != null && (
                <span className="text-[10px] text-slate-500">{fmtDuration(devStatus.uptimeMs)}</span>
              )}
              {cmd && (
                <span className="text-[10px] text-slate-500 font-mono truncate max-w-md" title={cmd}>
                  {cmd}
                </span>
              )}
              {state === "crashed" && devStatus?.lastExitCode != null && (
                <span className="text-[10px] text-red-400">exit {devStatus.lastExitCode}</span>
              )}

              <div className="ml-auto flex items-center gap-1.5">
                {state !== "running" && state !== "starting" && (
                  <button
                    onClick={() => startDev()}
                    disabled={devActing || noConfig}
                    title={noConfig ? "Set a dev command via the header pill or Board settings" : "Start dev server"}
                    className="claw-btn primary flex items-center gap-1"
                    style={{ fontSize: 10, padding: "3px 9px", opacity: (devActing || noConfig) ? 0.4 : 1 }}
                  >
                    {devActing
                      ? <><span className="w-2 h-2 rounded-full border border-current border-t-transparent animate-spin" />Starting…</>
                      : <><Play size={10} />Start</>
                    }
                  </button>
                )}
                {state === "running" && (
                  <>
                    <button
                      onClick={stopDev}
                      disabled={devActing}
                      className="claw-btn flex items-center gap-1"
                      style={{ fontSize: 10, padding: "3px 9px", borderColor: "rgba(255,107,107,0.35)", color: "var(--red)", opacity: devActing ? 0.4 : 1 }}
                    >
                      <Square size={10} />Stop
                    </button>
                    <button
                      onClick={restartDev}
                      disabled={devActing}
                      className="claw-btn flex items-center gap-1"
                      style={{ fontSize: 10, padding: "3px 9px", opacity: devActing ? 0.4 : 1 }}
                    >
                      <RotateCcw size={10} />Restart
                    </button>
                  </>
                )}
                <button
                  onClick={() => setDevLogsOpen((x) => !x)}
                  disabled={(devStatus?.logsAvailable ?? 0) === 0}
                  className="claw-btn flex items-center gap-1"
                  style={{ fontSize: 10, padding: "3px 9px", opacity: (devStatus?.logsAvailable ?? 0) === 0 ? 0.4 : 1 }}
                  title={(devStatus?.logsAvailable ?? 0) === 0 ? "No logs yet" : "Show recent logs"}
                >
                  {devLogsOpen ? <><ChevronUp size={10} />Logs</> : <><ChevronDown size={10} />Logs{devStatus?.logsAvailable ? ` (${devStatus.logsAvailable})` : ""}</>}
                </button>
              </div>
            </div>

            {noConfig && (
              <div className="px-3 pb-2 -mt-1">
                <p className="text-[10px] text-slate-500">
                  No dev command configured for this board. Click the <span className="text-slate-300">Dev</span> pill in the header (or open ⚙ Board settings) to set one and auto-detect from <span className="font-mono">package.json</span>.
                </p>
              </div>
            )}

            {state === "crashed" && (
              <div className="px-3 pb-2 -mt-1 flex flex-col gap-1.5">
                {devStatus?.lastError && (
                  <p className="text-[10px] text-red-300 font-mono whitespace-pre-wrap">{devStatus.lastError}</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => dispatchClaudeFix("crashed")}
                    disabled={dispatchingFix}
                    className="text-[10px] px-2 py-1 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white font-medium"
                  >
                    {dispatchingFix ? "Creating fix task…" : <><Bot size={11} /> Fix with Claude</>}
                  </button>
                  <button
                    onClick={() => setDevLogsOpen(true)}
                    className="text-[10px] text-slate-400 hover:text-slate-200"
                  >
                    <ChevronDown size={10} className="inline mr-0.5" />View logs
                  </button>
                </div>
              </div>
            )}

            {unreachable && (
              <div className="px-3 pb-2 -mt-1">
                <p className="text-[10px] text-amber-200/90 leading-relaxed">
                  The process is alive but nothing is listening on <span className="font-mono">:{port}</span>.
                  Common causes:
                </p>
                <ul className="text-[10px] text-amber-200/80 list-disc pl-4 leading-relaxed">
                  <li>Server still binding — wait a couple seconds and retry</li>
                  <li>Command doesn't actually start an HTTP server (e.g. just runs <span className="font-mono">echo</span>)</li>
                  <li>Server is listening on a different port — update the Port field in the header pill</li>
                </ul>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <button
                    onClick={() => dispatchClaudeFix("unreachable")}
                    disabled={dispatchingFix}
                    className="text-[10px] px-2 py-1 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white font-medium"
                    title="Create a high-priority task for Claude to debug + fix the dev server"
                  >
                    {dispatchingFix ? "Creating fix task…" : <><Bot size={11} /> Fix with Claude</>}
                  </button>
                  <button
                    onClick={() => setDevLogsOpen(true)}
                    className="text-[10px] text-slate-400 hover:text-slate-200"
                  >
                    <ChevronDown size={10} className="inline mr-0.5" />View logs
                  </button>
                </div>
              </div>
            )}

            {devLogsOpen && (
              <div className="border-t border-slate-700/60 bg-slate-950 px-3 py-2 max-h-44 overflow-y-auto font-mono text-[10px] leading-relaxed">
                {devLogs.length === 0 ? (
                  <p className="text-slate-700 italic">No logs yet.</p>
                ) : (
                  devLogs.map((l, i) => (
                    <p key={i} className={l.stream === "stderr" ? "text-red-300" : "text-slate-300"}>
                      {l.text}
                    </p>
                  ))
                )}
              </div>
            )}
          </section>
        );
      })()}

      {/* ── Dashboard ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
            Test case dashboard
            {allCases.length > 0 && (
              <span className="ml-2 normal-case font-normal text-slate-400">
                ({totalPass}/{allCases.length} passing
                {totalRun < allCases.length && `, ${allCases.length - totalRun} not run`})
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            {uncoveredWithoutCases > 0 && (
              <button
                onClick={generateForAllUncovered}
                className="text-[10px] px-2.5 py-1 rounded bg-emerald-900/60 hover:bg-emerald-800 text-emerald-200 border border-emerald-800/50 font-medium"
              >
                <Sparkles size={10} className="inline mr-1" />Generate for {uncoveredWithoutCases} criteria
              </button>
            )}
            {allCases.length > 0 && (
              <div className="flex items-center gap-1">
                {allTags.length > 0 && (
                  <select
                    value={tagFilter ?? ""}
                    onChange={(e) => setTagFilter(e.target.value || null)}
                    className="text-[10px] px-1.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 focus:outline-none"
                    title="Filter Run-all by tag"
                  >
                    <option value="">all cases ({testCases.length})</option>
                    {allTags.map((t) => {
                      const count = testCases.filter((c) => (c.tags ?? []).includes(t)).length;
                      return <option key={t} value={t}>#{t} ({count})</option>;
                    })}
                  </select>
                )}
                <button
                  onClick={runAllCases}
                  className="text-[10px] px-2.5 py-1 rounded bg-indigo-700 hover:bg-indigo-600 text-white font-medium"
                  title={tagFilter ? `Run ${filteredCases.length} case(s) tagged #${tagFilter}` : "Run every case"}
                >
                  <Play size={10} className="inline mr-1" />
                  {tagFilter ? `Run #${tagFilter} (${filteredCases.length})` : "Run all cases"}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Optional shared base URL */}
        {allCases.some((c) => c.kind === "api") && (() => {
          const devUrl = devStatus?.state === "running" && devStatus.port != null
            ? `http://localhost:${devStatus.port}` : null;
          const showingDev = !!devUrl && baseUrl === devUrl;
          return (
            <div className="flex items-center gap-2 flex-wrap text-[10px] text-slate-500">
              <span className="uppercase tracking-wider font-semibold">Base URL</span>
              {effectiveSuggestions.length > 0 ? (
                <select
                  value={baseUrl}
                  onChange={(e) => { setBaseUrl(e.target.value); setBaseUrlOverridden(true); }}
                  className="font-mono bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-slate-300 focus:outline-none"
                >
                  {effectiveSuggestions.map((s) => (
                    <option key={s.url} value={s.url}>
                      {s.url}{s.source === "running" ? " · live" : ""}
                    </option>
                  ))}
                  <option value="">(custom)</option>
                </select>
              ) : null}
              {(effectiveSuggestions.length === 0 || baseUrl === "") && (
                <input
                  value={baseUrl}
                  onChange={(e) => { setBaseUrl(e.target.value); setBaseUrlOverridden(true); }}
                  placeholder="http://localhost:3100"
                  className="font-mono bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-slate-300 focus:outline-none w-52 placeholder:text-slate-600"
                />
              )}
              {showingDev && (
                <span className="text-[9px] text-emerald-400/80 flex items-center gap-1">
                  <span className="w-1 h-1 rounded-full bg-emerald-400" />
                  tracking dev server
                </span>
              )}
              {devUrl && !showingDev && (
                <button
                  onClick={() => { setBaseUrl(devUrl); setBaseUrlOverridden(false); }}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
                  title="Use the running dev server's port"
                >
                  → use :{devStatus!.port}
                </button>
              )}
            </div>
          );
        })()}

        {/* Per-criterion rows */}
        <div className="flex flex-col gap-2">
          {localCriteria.length === 0 && (
            <p className="text-xs text-slate-600 italic">No criteria yet. Add one below.</p>
          )}
          {coverage.map(({ criterion, match }, i) => {
            const cases = casesByCriterion.get(i) ?? [];
            const status: "suite-pass" | "suite-fail" | "cases-pass" | "cases-fail" | "cases-mixed" | "no-cases" =
              match ? (match.passed ? "suite-pass" : "suite-fail")
              : cases.length === 0 ? "no-cases"
              : cases.every((c) => c.lastRun?.passed) && cases.every((c) => c.lastRun) ? "cases-pass"
              : cases.some((c) => c.lastRun && !c.lastRun.passed) ? "cases-fail"
              : "cases-mixed";

            const headerCls =
              status === "suite-pass" || status === "cases-pass" ? "border-emerald-800/40 bg-emerald-950/20"
              : status === "suite-fail" || status === "cases-fail" ? "border-red-800/40 bg-red-950/20"
              : status === "cases-mixed" ? "border-slate-700 bg-slate-800/40"
              : "border-amber-800/40 bg-amber-950/10";

            const icon =
              status === "suite-pass" || status === "cases-pass" ? "✓"
              : status === "suite-fail" || status === "cases-fail" ? "✗"
              : status === "cases-mixed" ? "○"
              : "⚠";

            const iconCls =
              status === "suite-pass" || status === "cases-pass" ? "text-emerald-400"
              : status === "suite-fail" || status === "cases-fail" ? "text-red-400"
              : status === "cases-mixed" ? "text-slate-400"
              : "text-amber-400";

            return (
              <div key={i} className={`rounded-lg border ${headerCls} flex flex-col`}>
                <div className="flex items-start gap-2.5 px-3 py-2">
                  <span className={`shrink-0 w-3 text-center font-bold mt-0.5 ${iconCls}`}>{icon}</span>
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <p className="text-xs text-slate-200 leading-relaxed">{criterion}</p>
                    {match && (
                      <p className="text-[10px] text-slate-500">
                        <span className="text-slate-600">suite test:</span>{" "}
                        <span className="font-mono text-slate-400">{match.name}</span>
                        {match.duration && <span className="text-slate-600 ml-1.5">{match.duration}</span>}
                      </p>
                    )}
                    {!match && cases.length === 0 && (
                      <p className="text-[10px] text-amber-500/80">No suite test{suiteResult ? "" : " (run suite to check)"} — generate cases below.</p>
                    )}
                    {cases.length > 0 && (
                      <p className="text-[10px] text-slate-500">{cases.length} test case{cases.length === 1 ? "" : "s"}</p>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-1">
                    {cases.length === 0 && !match && (
                      <button
                        onClick={() => generateForCriterion(i)}
                        className="text-[10px] px-2 py-0.5 rounded bg-emerald-900/60 hover:bg-emerald-800 text-emerald-200"
                      >
                        <Sparkles size={10} className="inline mr-1" />Generate
                      </button>
                    )}
                    {cases.length > 0 && (
                      <button
                        onClick={() => regenerateForCriterion(i)}
                        className="text-[10px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
                        title="Replace existing cases with newly-generated ones from the criterion text"
                      >
                        <RefreshCw size={10} className="inline mr-1" />Regenerate
                      </button>
                    )}
                    <button
                      onClick={() => addManualCase(i, "api")}
                      className="text-[10px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
                      title="Add manual API test case"
                    >
                      + Case
                    </button>
                  </div>
                </div>

                {/* Test cases under this criterion */}
                {cases.length > 0 && (
                  <div className="flex flex-col border-t border-slate-700/50">
                    {cases.map((tc) => {
                      const expanded = expandedCases.has(tc.id);
                      const busy = busyCases.has(tc.id);
                      const r = tc.lastRun;
                      const resultCls = r ? (r.passed ? "text-emerald-400" : "text-red-400") : "text-slate-500";
                      return (
                        <div key={tc.id} className="flex flex-col border-b last:border-b-0 border-slate-800/60">
                          <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-900/40">
                            <button
                              onClick={() => setExpandedCases((p) => { const n = new Set(p); n.has(tc.id) ? n.delete(tc.id) : n.add(tc.id); return n; })}
                              className="text-slate-600 hover:text-slate-300 w-3 text-center"
                            >
                              {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                            </button>
                            <span className={`text-[10px] font-bold w-3 ${resultCls}`}>
                              {r ? (r.passed ? <Check size={10} /> : <X size={10} />) : "·"}
                            </span>
                            <span className="text-[11px] text-slate-300 flex-1 truncate font-mono">
                              {tc.kind === "api"
                                ? <><span className="text-indigo-400">{tc.method}</span> {tc.path}{tc.expectedStatus !== undefined && <span className="text-slate-500"> → {tc.expectedStatus}</span>}</>
                                : <>$ {tc.command || <span className="text-slate-600 italic">(empty)</span>}</>}
                            </span>
                            {/* Lifecycle chips: only render when set to non-default values */}
                            {tc.timeoutMs !== undefined && tc.timeoutMs !== 30000 && (
                              <span className="text-[10px] text-amber-400/80 shrink-0" title="Per-case timeout">
                                ⏱{tc.timeoutMs >= 1000 ? `${Math.round(tc.timeoutMs / 1000)}s` : `${tc.timeoutMs}ms`}
                              </span>
                            )}
                            {tc.retry?.count && tc.retry.count > 0 && (
                              <span className="text-[10px] text-amber-400/80 shrink-0" title={`Retry ${tc.retry.count}× with ${tc.retry.backoffMs ?? 0}ms backoff`}>
                                🔁{tc.retry.count}×{r?.attempts && r.attempts > 1 ? <span className="text-slate-500"> ({r.attempts})</span> : ""}
                              </span>
                            )}
                            {r?.timedOut && (
                              <span className="text-[10px] text-red-400 shrink-0" title="Last attempt timed out">⏱✗</span>
                            )}
                            {/* Tag pills (Phase 3e) */}
                            {tc.tags && tc.tags.length > 0 && (
                              <span className="flex gap-1 shrink-0">
                                {tc.tags.map((t) => (
                                  <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                                    #{t}
                                  </span>
                                ))}
                              </span>
                            )}
                            {r && <span className="text-[10px] text-slate-500 shrink-0">{fmtDuration(r.durationMs)}</span>}
                            <CaseSparkline taskId={task.id} caseId={tc.id} />
                            <button
                              onClick={() => runCase(tc.id)}
                              disabled={busy}
                              className="text-[10px] px-2 py-0.5 rounded bg-indigo-700 hover:bg-indigo-600 disabled:opacity-40 text-white shrink-0"
                            >
                              {busy ? <span className="w-2.5 h-2.5 border border-white/30 border-t-white rounded-full animate-spin inline-block" /> : <Play size={10} />}
                            </button>
                            <button
                              onClick={() => deleteCase(tc.id)}
                              className="text-slate-600 hover:text-red-400 px-1 flex items-center"
                              title="Delete case"
                            ><X size={12} /></button>
                          </div>

                          {expanded && (
                            <div className="px-3 py-2 bg-slate-950/40 flex flex-col gap-2">
                              {tc.notes && (
                                <p className="text-[10px] text-slate-500 italic leading-relaxed border-l-2 border-slate-700 pl-2">
                                  {tc.notes}
                                  {tc.dependsOnCaseId && " · Sequence case: depends on the prior case in this criterion."}
                                </p>
                              )}
                              <input
                                value={tc.label}
                                onChange={(e) => updateCase(tc.id, { label: e.target.value })}
                                placeholder="Label"
                                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none"
                              />
                              {tc.kind === "api" ? (
                                <>
                                  <div className="flex gap-1.5">
                                    <select
                                      value={tc.method ?? "GET"}
                                      onChange={(e) => updateCase(tc.id, { method: e.target.value })}
                                      className="bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-[11px] text-slate-200 w-20 shrink-0 focus:outline-none font-mono"
                                    >
                                      {HTTP_METHODS.map((m) => <option key={m}>{m}</option>)}
                                    </select>
                                    <input
                                      value={tc.path ?? ""}
                                      onChange={(e) => updateCase(tc.id, { path: e.target.value })}
                                      placeholder="/path"
                                      className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-[11px] text-slate-100 font-mono focus:outline-none"
                                    />
                                    <span className="text-[10px] text-slate-500 self-center">expect</span>
                                    <input
                                      type="number"
                                      value={tc.expectedStatus ?? 200}
                                      onChange={(e) => updateCase(tc.id, { expectedStatus: Number(e.target.value) })}
                                      className="w-14 bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none text-center"
                                    />
                                  </div>
                                  {!["GET", "DELETE", "HEAD"].includes(tc.method ?? "GET") && (
                                    <textarea
                                      rows={2}
                                      value={tc.body ?? ""}
                                      onChange={(e) => updateCase(tc.id, { body: e.target.value })}
                                      placeholder='Body (JSON or text)'
                                      className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-[11px] text-slate-100 font-mono focus:outline-none resize-none placeholder:text-slate-600"
                                    />
                                  )}
                                  <input
                                    value={tc.expectedBodyContains ?? ""}
                                    onChange={(e) => updateCase(tc.id, { expectedBodyContains: e.target.value })}
                                    placeholder='Body must contain (optional, e.g. "tags":[])'
                                    className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-[11px] text-slate-100 font-mono focus:outline-none placeholder:text-slate-600"
                                  />
                                </>
                              ) : (
                                <>
                                  <input
                                    value={tc.command ?? ""}
                                    onChange={(e) => updateCase(tc.id, { command: e.target.value })}
                                    placeholder="$ shell command"
                                    className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-[11px] text-slate-100 font-mono focus:outline-none placeholder:text-slate-600"
                                  />
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-slate-500">expected exit code:</span>
                                    <input
                                      type="number"
                                      value={tc.expectedExitCode ?? 0}
                                      onChange={(e) => updateCase(tc.id, { expectedExitCode: Number(e.target.value) })}
                                      className="w-14 bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none text-center"
                                    />
                                  </div>
                                </>
                              )}

                              {/* Phase-3a/3e: Lifecycle (timeout, retry) + tags editor.
                                  Defaults are kept invisible — only when the user sets
                                  non-default values do chips appear in the header row. */}
                              <details className="text-[11px]">
                                <summary className="cursor-pointer text-slate-500 hover:text-indigo-300 select-none py-0.5">
                                  Lifecycle & tags
                                </summary>
                                <div className="mt-1.5 pl-2 border-l-2 border-slate-800 flex flex-col gap-1.5">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] text-slate-500 uppercase tracking-wider shrink-0">Timeout</span>
                                    <input
                                      type="number"
                                      min={100}
                                      max={120000}
                                      step={500}
                                      value={tc.timeoutMs ?? ""}
                                      onChange={(e) => {
                                        const v = e.target.value === "" ? undefined : Number(e.target.value);
                                        updateCase(tc.id, { timeoutMs: v });
                                      }}
                                      placeholder="30000"
                                      className="w-24 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none placeholder:text-slate-600"
                                    />
                                    <span className="text-[10px] text-slate-600">ms</span>
                                  </div>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] text-slate-500 uppercase tracking-wider shrink-0">Retry</span>
                                    <input
                                      type="number"
                                      min={0}
                                      max={10}
                                      value={tc.retry?.count ?? ""}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        if (v === "" || Number(v) === 0) updateCase(tc.id, { retry: undefined });
                                        else updateCase(tc.id, { retry: { count: Number(v), backoffMs: tc.retry?.backoffMs ?? 1000 } });
                                      }}
                                      placeholder="0"
                                      className="w-14 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none placeholder:text-slate-600 text-center"
                                    />
                                    <span className="text-[10px] text-slate-600">attempts after fail</span>
                                    <span className="text-[10px] text-slate-600">·</span>
                                    <input
                                      type="number"
                                      min={0}
                                      step={250}
                                      value={tc.retry?.backoffMs ?? ""}
                                      disabled={!tc.retry?.count}
                                      onChange={(e) => updateCase(tc.id, { retry: { count: tc.retry?.count ?? 1, backoffMs: Number(e.target.value) } })}
                                      placeholder="1000"
                                      className="w-20 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none placeholder:text-slate-600 disabled:opacity-40"
                                    />
                                    <span className="text-[10px] text-slate-600">ms backoff</span>
                                  </div>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] text-slate-500 uppercase tracking-wider shrink-0">Tags</span>
                                    <input
                                      value={(tc.tags ?? []).join(", ")}
                                      onChange={(e) => {
                                        const tags = e.target.value
                                          .split(",")
                                          .map((s) => s.trim().replace(/^#/, ""))
                                          .filter(Boolean);
                                        updateCase(tc.id, { tags: tags.length > 0 ? tags : undefined });
                                      }}
                                      placeholder="smoke, regression, slow"
                                      className="flex-1 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none placeholder:text-slate-600"
                                    />
                                  </div>
                                </div>
                              </details>

                              {/* Phase-3c: Setup / teardown hooks. Setup runs before
                                  the main case; failure halts. Teardown always runs;
                                  failure is warning-only. */}
                              <details className="text-[11px]" open={(tc.setup?.length ?? 0) + (tc.teardown?.length ?? 0) > 0}>
                                <summary className="cursor-pointer text-slate-500 hover:text-indigo-300 select-none py-0.5">
                                  Setup & teardown
                                  {(tc.setup?.length ?? 0) > 0 && <span className="text-slate-600"> · {tc.setup!.length} setup</span>}
                                  {(tc.teardown?.length ?? 0) > 0 && <span className="text-slate-600"> · {tc.teardown!.length} teardown</span>}
                                </summary>
                                <div className="mt-1.5 pl-2 border-l-2 border-slate-800 flex flex-col gap-2">
                                  <HookList
                                    label="Setup"
                                    hooks={tc.setup ?? []}
                                    onChange={(next) => updateCase(tc.id, { setup: next.length > 0 ? next : undefined })}
                                  />
                                  <HookList
                                    label="Teardown"
                                    hooks={tc.teardown ?? []}
                                    onChange={(next) => updateCase(tc.id, { teardown: next.length > 0 ? next : undefined })}
                                  />
                                </div>
                              </details>

                              {/* Phase-2 typed assertion editor — coexists with the legacy
                                  Status/Body-contains fields above. When this list is
                                  non-empty, deriveAssertions() prefers it over the legacy
                                  fields at run time. */}
                              <details className="text-[11px]" open={tc.assertions !== undefined && tc.assertions.length > 0}>
                                <summary className="cursor-pointer text-slate-500 hover:text-indigo-300 select-none py-0.5">
                                  Advanced assertions{tc.assertions && tc.assertions.length > 0 ? ` (${tc.assertions.length})` : ""}
                                </summary>
                                <div className="mt-1.5 pl-2 border-l-2 border-slate-800">
                                  <AssertionListEditor
                                    kind={tc.kind}
                                    assertions={tc.assertions ?? []}
                                    onChange={(next) => updateCase(tc.id, { assertions: next })}
                                  />
                                  {tc.assertions && tc.assertions.length > 0 && (
                                    <p className="text-[9px] text-slate-600 mt-1.5">
                                      ⚠ When set, the assertion list takes precedence over the legacy fields above.
                                    </p>
                                  )}
                                </div>
                              </details>

                              {r && (
                                <div className={`text-[11px] rounded px-2 py-1.5 border ${r.passed ? "bg-emerald-950/40 border-emerald-800/40 text-emerald-300" : "bg-red-950/40 border-red-800/40 text-red-300"}`}>
                                  <p className="font-semibold flex items-center gap-2">
                                    {r.passed ? "✓ Pass" : "✗ Fail"}
                                    {r.actualStatus !== undefined && <span className="font-mono">{r.actualStatus}</span>}
                                    {r.actualExitCode !== undefined && <span className="font-mono">exit {r.actualExitCode}</span>}
                                    <span className="text-slate-500 font-normal ml-auto">{new Date(r.ranAt).toLocaleTimeString()}</span>
                                  </p>

                                  {/* Per-assertion breakdown — shows exactly which checks passed and which failed. */}
                                  {r.assertions && r.assertions.length > 0 && (
                                    <div className="mt-1.5 flex flex-col gap-0.5">
                                      {r.assertions.map((a, ai) => (
                                        <div key={ai} className="flex items-start gap-1.5 text-[10px]">
                                          <span className={`shrink-0 w-3 text-center font-bold mt-0.5 ${a.passed ? "text-emerald-400" : "text-red-400"}`}>
                                            {a.passed ? "✓" : "✗"}
                                          </span>
                                          <span className="text-slate-300 shrink-0">{a.label}:</span>
                                          {a.passed ? (
                                            <span className="text-emerald-300/80 font-mono break-all">{a.actual}</span>
                                          ) : (
                                            <span className="text-slate-300/80 break-all">
                                              expected <span className="font-mono text-emerald-300/80">{a.expected}</span>{" "}
                                              · got <span className="font-mono text-red-300">{a.actual}</span>
                                            </span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  <pre className="text-[10px] font-mono text-slate-400 mt-1.5 whitespace-pre-wrap max-h-40 overflow-y-auto">{r.output}</pre>

                                  {!r.passed && looksLikeConnRefused(r.output) && devStatus?.state !== "running" && (
                                    <div className="mt-2 rounded border border-amber-700/50 bg-amber-950/40 px-2 py-1.5 flex items-center justify-between gap-2">
                                      <p className="text-[10px] text-amber-200">
                                        Looks like your dev server is down.
                                      </p>
                                      <button
                                        onClick={() => startDevAndRetry(tc.id)}
                                        disabled={devActing}
                                        className="claw-btn primary flex items-center gap-1 shrink-0"
                                        style={{ fontSize: 10, padding: "2px 8px", opacity: devActing ? 0.4 : 1 }}
                                      >
                                        {devActing ? "Starting…" : <><Play size={10} />Start & retry</>}
                                      </button>
                                    </div>
                                  )}

                                  {/* Bug-raise actions — for any failure that ISN'T connection-refused.
                                      (Connection-refused has its own "Start & retry" affordance above.) */}
                                  {!r.passed && !(looksLikeConnRefused(r.output) && devStatus?.state !== "running") && (
                                    <div className="mt-2 pt-2 border-t border-red-800/30 flex items-center justify-between gap-2 flex-wrap">
                                      <p className="text-[10px] text-red-300/80">
                                        Failing? Pick a next step:
                                      </p>
                                      <div className="flex items-center gap-1.5">
                                        <button
                                          onClick={() => runCase(tc.id)}
                                          disabled={busy}
                                          className="text-[10px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40"
                                          title="Re-run this case (sometimes flaky, sometimes the dev server just needed a moment)"
                                        >
                                          <RotateCcw size={10} className="inline mr-1" />Retry
                                        </button>
                                        <button
                                          onClick={() => raiseBugFromCase(tc.id, "backlog")}
                                          disabled={raisingBug.has(tc.id)}
                                          className="text-[10px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40"
                                          title="Create a bug task with full context in the Backlog column for later"
                                        >
                                          <Bug size={10} className="inline mr-1" />Backlog
                                        </button>
                                        <button
                                          onClick={() => raiseBugFromCase(tc.id, "fix-now")}
                                          disabled={raisingBug.has(tc.id)}
                                          className="text-[10px] px-2 py-0.5 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white font-medium"
                                          title="Create a bug task AND dispatch Claude to fix it immediately"
                                        >
                                          {raisingBug.has(tc.id) ? "Dispatching…" : <><Bot size={10} className="inline mr-1" />Fix now</>}
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Add criterion */}
        <div className="flex gap-2 mt-1">
          <input
            value={newCriterion}
            onChange={(e) => setNewCriterion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCriterion()}
            placeholder="Add criterion (e.g. POST /notes/:id/tags with new name creates and attaches)…"
            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2.5 py-1 text-xs text-slate-100 focus:outline-none focus:border-slate-400 placeholder:text-slate-600"
          />
          <button
            onClick={addCriterion}
            disabled={criteriaSaving || !newCriterion.trim()}
            className="text-xs px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 shrink-0"
          >
            {criteriaSaving ? "Saving…" : "+ Add"}
          </button>
        </div>
      </section>

      {/* ── Orphan tests ── */}
      {orphanTests.length > 0 && (
        <section className="flex flex-col gap-2">
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
            Other suite tests ({orphanTests.length}) — ran but didn't map to a criterion
          </p>
          <div className="flex flex-col gap-0.5 rounded-lg border border-slate-700/50 overflow-hidden">
            {orphanTests.map((t, i) => (
              <div key={i} className={`flex items-center gap-2 px-3 py-1 text-[11px] ${t.passed ? "bg-slate-800/30 text-slate-400" : "bg-red-950/20 text-red-300"}`}>
                <span className="shrink-0 w-3 text-center font-bold">{t.passed ? "✓" : "✗"}</span>
                <span className="flex-1 truncate font-mono">{t.name}</span>
                {t.duration && <span className="text-slate-600 text-[10px]">{t.duration}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── 14-day pass/fail sparkline (Phase 3d) ──────────────────────────────────

interface TrendDay { date: string; passes: number; fails: number; }
interface TrendData { total: number; passed: number; trend: TrendDay[] }

function CaseSparkline({ taskId, caseId }: { taskId: string; caseId: string }) {
  const [data, setData] = useState<TrendData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.tasks.trend(taskId, caseId, 14)
        .then((t) => { if (!cancelled) setData(t); })
        .catch(() => { /* no history yet */ });
    };
    load();
    const onRan = (ev: Event) => {
      const detail = (ev as CustomEvent<{ caseId?: string }>).detail;
      if (detail?.caseId === caseId) load();
    };
    window.addEventListener("agent-trail:case-ran", onRan as EventListener);
    return () => { cancelled = true; window.removeEventListener("agent-trail:case-ran", onRan as EventListener); };
  }, [taskId, caseId]);

  if (!data || data.total === 0) return null;

  const W = 56;
  const H = 14;
  const days = data.trend;
  const max = Math.max(1, ...days.map((d) => d.passes + d.fails));
  const colW = W / days.length;
  const passRate = data.total > 0 ? Math.round((100 * data.passed) / data.total) : 0;
  const title = `Last 14 days: ${data.passed}/${data.total} green (${passRate}%)`;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-label={title}>
      <title>{title}</title>
      {days.map((d, i) => {
        const total = d.passes + d.fails;
        if (total === 0) {
          return <rect key={i} x={i * colW + 0.5} y={H - 1} width={Math.max(0.5, colW - 1)} height={0.5} fill="#334155" />;
        }
        const totalH = (total / max) * H;
        const passH = (d.passes / total) * totalH;
        const failH = totalH - passH;
        const x = i * colW + 0.5;
        const w = Math.max(0.5, colW - 1);
        return (
          <g key={i}>
            {failH > 0 && <rect x={x} y={H - totalH} width={w} height={failH} fill="#f87171" />}
            {passH > 0 && <rect x={x} y={H - passH} width={w} height={passH} fill="#34d399" />}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Setup / teardown hook list editor (Phase 3c) ───────────────────────────

function HookList({ label, hooks, onChange }: {
  label: string;
  hooks: TestCaseHook[];
  onChange: (next: TestCaseHook[]) => void;
}) {
  const add = (kind: "api" | "shell") => {
    const fresh: TestCaseHook = kind === "api"
      ? { id: crypto.randomUUID(), kind: "api", method: "POST", path: "/", body: "" }
      : { id: crypto.randomUUID(), kind: "shell", command: "" };
    onChange([...hooks, fresh]);
  };
  const update = (i: number, patch: Partial<TestCaseHook>) =>
    onChange(hooks.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  const remove = (i: number) => onChange(hooks.filter((_, idx) => idx !== i));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
        <div className="flex gap-1">
          <button onClick={() => add("api")} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">+ API</button>
          <button onClick={() => add("shell")} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">+ Shell</button>
        </div>
      </div>
      {hooks.length === 0 ? (
        <p className="text-[10px] italic text-slate-600">No {label.toLowerCase()} hooks.</p>
      ) : (
        hooks.map((h, i) => (
          <div key={h.id} className="bg-slate-900 border border-slate-800 rounded px-2 py-1 flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <input
                value={h.label ?? ""}
                onChange={(e) => update(i, { label: e.target.value || undefined })}
                placeholder={h.kind === "api" ? "reset DB" : "seed users"}
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none placeholder:text-slate-600"
              />
              <button onClick={() => remove(i)} className="text-slate-500 hover:text-red-400 p-0.5" title="Delete hook">
                <X size={11} />
              </button>
            </div>
            {h.kind === "api" ? (
              <>
                <div className="flex gap-1">
                  <select
                    value={h.method ?? "POST"}
                    onChange={(e) => update(i, { method: e.target.value })}
                    className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 w-16 focus:outline-none font-mono"
                  >
                    {HTTP_METHODS.map((m) => <option key={m}>{m}</option>)}
                  </select>
                  <input
                    value={h.path ?? ""}
                    onChange={(e) => update(i, { path: e.target.value })}
                    placeholder="/admin/reset"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] text-slate-100 font-mono focus:outline-none placeholder:text-slate-600"
                  />
                </div>
                {!["GET", "DELETE", "HEAD"].includes(h.method ?? "GET") && (
                  <textarea
                    rows={1}
                    value={h.body ?? ""}
                    onChange={(e) => update(i, { body: e.target.value })}
                    placeholder="Body (optional)"
                    className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] text-slate-100 font-mono focus:outline-none resize-none placeholder:text-slate-600"
                  />
                )}
              </>
            ) : (
              <input
                value={h.command ?? ""}
                onChange={(e) => update(i, { command: e.target.value })}
                placeholder="$ rm -rf /tmp/test-*"
                className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] text-slate-100 font-mono focus:outline-none placeholder:text-slate-600"
              />
            )}
          </div>
        ))
      )}
    </div>
  );
}
