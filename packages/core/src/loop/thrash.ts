// PRD_OPEN_SOURCE §5.3 — thrash detection.
//
// Signals we treat as "the agent is stuck in a loop, don't burn more budget":
//   • Same verify_tests failure twice in a row (error message near-identical)
//   • Two consecutive implement executions produced zero file changes
//
// Detection stays pure — the execution manager wires it into the verify_tests
// handler + raises a decision ticket + leaves the task blocked. No auto-retry
// once thrash is detected: the human sees the history and decides.

export interface ExecutionSample {
  status: string;
  tddPhase: string | null;
  errorMessage: string | null;
  /** rows from `artifacts` where kind='git_diff' for this execution; empty
   *  string when no diff was captured. Only used for the zero-change signal. */
  gitDiffLength?: number;
}

export type ThrashSignal = "repeated_failure" | "no_file_changes";

export interface ThrashVerdict {
  thrash: boolean;
  signal?: ThrashSignal;
  /** Human-readable line for the decision-ticket context field. */
  reason?: string;
  /** Compact history the ticket includes so the human sees the pattern. */
  history?: string[];
}

// Match cutoff for "same error" — we look at the last 300 chars because
// stack traces near the failure site are where the identity signal lives.
const ERROR_CMP_TAIL = 300;

/**
 * Given the recent execution history for a single task (newest → oldest),
 * decide whether the current situation looks like thrash. The caller has
 * already established that the latest execution failed at verify_tests.
 */
export function detectThrash(recent: ExecutionSample[]): ThrashVerdict {
  if (recent.length === 0) return { thrash: false };
  const latest = recent[0]!;

  // ─── Signal 1: repeated identical verify_tests failure ────────────────
  const verifyFailures = recent.filter((e) => e.tddPhase === "verify_tests" && e.status === "failed");
  if (verifyFailures.length >= 2) {
    const a = normalize(verifyFailures[0]!.errorMessage);
    const b = normalize(verifyFailures[1]!.errorMessage);
    if (a && b && a === b) {
      return {
        thrash: true,
        signal: "repeated_failure",
        reason: `verify_tests failed with the same error twice in a row — the fix loop is not converging.`,
        history: verifyFailures.slice(0, 3).map((f, i) =>
          `attempt ${i + 1}: ${truncate(f.errorMessage ?? "(no error message)", 200)}`),
      };
    }
  }

  // ─── Signal 2: two consecutive implement runs produced no file changes ─
  const implementRuns = recent.filter((e) => e.tddPhase === "implement" && e.status === "completed");
  if (implementRuns.length >= 2) {
    const bothEmpty = implementRuns.slice(0, 2).every((e) => (e.gitDiffLength ?? 0) < 5);
    if (bothEmpty) {
      return {
        thrash: true,
        signal: "no_file_changes",
        reason: "two consecutive implement runs produced no file changes — the agent is doing analysis-only work.",
        history: [
          "implement run #1 → 0 file changes",
          "implement run #2 → 0 file changes",
          latest.errorMessage ? `latest verify_tests: ${truncate(latest.errorMessage, 200)}` : "",
        ].filter(Boolean),
      };
    }
  }

  return { thrash: false };
}

function normalize(msg: string | null | undefined): string {
  if (!msg) return "";
  // Two runs of the same failing suite produce output that differs in ways
  // that don't matter for identity: absolute paths (different tempdirs),
  // durations ([1.23ms]), line numbers when the file was edited between
  // runs, and PIDs. Strip all of them so the identity check catches actual
  // repeat failures without being fooled by cosmetic drift.
  //
  // ORDER MATTERS: normalize the WHOLE message, then take the tail.
  //
  // The reverse (slice first, then normalize) was a real defect. Substitutions
  // change LENGTH — "[12.34ms]" and "[9.1ms]" collapse to the same token from
  // different numbers of characters — so slicing first made two identical
  // failures start at different logical offsets inside the message. Their
  // normalized tails then differed at the leading edge and compared unequal,
  // so genuine thrash went undetected and the loop kept burning tokens. It
  // reproduced as a ~1-in-4 "flaky" e2e; it was the detector, not the test.
  const cleaned = msg
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;]*m/g, "")               // ANSI colour
    .replace(/\/(?:tmp|var|private|Users|home)\/[^\s"']+/g, "<path>")
    .replace(/\[\s*[\d.]+\s*(?:ms|s|µs)\s*\]/gi, "[<dur>]")
    .replace(/:\d+(?::\d+)?/g, ":<n>")             // line:col in stack traces
    .replace(/\bpid[= ]?\d+/gi, "pid=<n>")
    .replace(/\b\d+\b/g, "<n>")                     // any lingering numbers
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(-ERROR_CMP_TAIL);
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}
