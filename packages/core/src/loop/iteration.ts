// PRD_OPEN_SOURCE §5.2 — Ralph mode iteration memory.
//
// Every time a task's verify_tests fails and we re-spawn (fresh context via
// §4.5 auto-restart), the next iteration starts blank — it doesn't know
// what the previous attempt tried. Ralph's insight: don't compact the
// session, hand the fresh spawn a tiny ~200-token "what I tried and why
// it failed" summary. Kills context rot AND stops the agent from repeating
// the same fix.
//
// This module is pure — the execution manager does the wiring.

export interface IterationSample {
  iteration: number;
  summary: string;
  /** Last N chars of the test output — where the error usually lives. */
  testOutputTail?: string | null;
  /** First N chars of the git diff — signals what the agent tried to change. */
  gitDiffHead?: string | null;
}

export interface BuildIterationMemoryInput {
  taskTitle: string;
  iteration: number;
  testOutput?: string | null;
  gitDiff?: string | null;
  exitCode?: number | null;
}

const OUTPUT_TAIL_CHARS = 800;
const DIFF_HEAD_CHARS = 400;

export function buildIterationMemory(input: BuildIterationMemoryInput): {
  summary: string;
  testOutputTail: string | null;
  gitDiffHead: string | null;
} {
  const errorHeadline = extractErrorHeadline(input.testOutput);
  const filesChanged = countFilesChanged(input.gitDiff);
  const summary = [
    `Iteration ${input.iteration} of "${input.taskTitle}" failed`,
    input.exitCode != null ? `(exit ${input.exitCode})` : "",
    errorHeadline ? `— error: ${truncate(errorHeadline, 220)}` : "",
    filesChanged != null ? `. ${filesChanged} file(s) changed.` : ".",
    " Do not repeat the same fix; try a different angle.",
  ].filter(Boolean).join(" ");
  return {
    summary,
    testOutputTail: input.testOutput ? tail(input.testOutput, OUTPUT_TAIL_CHARS) : null,
    gitDiffHead:    input.gitDiff    ? head(input.gitDiff,    DIFF_HEAD_CHARS) : null,
  };
}

/** Render a compact iteration-history section for the L1 pack. Most-recent
 *  iteration LAST (so the agent reads chronologically). Empty list = "". */
export function renderIterationHistory(samples: IterationSample[]): string {
  if (samples.length === 0) return "";
  const ordered = [...samples].sort((a, b) => a.iteration - b.iteration);
  const lines = ordered.map((s) => {
    const parts = [`Iter ${s.iteration}: ${s.summary}`];
    if (s.testOutputTail) parts.push(`  tests(tail): ${truncate(s.testOutputTail.replace(/\n/g, " ⏎ "), 300)}`);
    if (s.gitDiffHead)    parts.push(`  diff(head): ${truncate(s.gitDiffHead.replace(/\n/g, " ⏎ "), 200)}`);
    return parts.join("\n");
  });
  return `\n=== Prior iterations (Ralph memory) ===\n${lines.join("\n\n")}\n`;
}

function extractErrorHeadline(output: string | null | undefined): string | null {
  if (!output) return null;
  // Look for the first line that looks like a test-runner error signal.
  // Prioritise typed exception names, then "FAIL", then any line with "expect".
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const typed = lines.find((l) => /^[A-Z][a-zA-Z]+Error(:|\s)/.test(l));
  if (typed) return typed;
  const fail = lines.find((l) => /\bFAIL\b|\bfailed\b|✗/.test(l));
  if (fail) return fail;
  const assertion = lines.find((l) => /\bexpect\b/i.test(l));
  return assertion ?? lines[0] ?? null;
}

function countFilesChanged(gitDiff: string | null | undefined): number | null {
  if (!gitDiff) return null;
  const matches = gitDiff.match(/^diff --git /gm) ?? [];
  return matches.length;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`;
}
function tail(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(-n)}`;
}
function head(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
