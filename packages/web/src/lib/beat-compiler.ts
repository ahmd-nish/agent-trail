// PRD_FEED_EXPERIENCE §1 — the Beat Compiler.
//
// One client-side layer between the SSE stream and rendering. Turns raw
// UiEvents into semantic "beats" carrying verb, subject, why, outcome,
// magnitude, mood. The theme renderers below (Mission Control / Matrix /
// Arcade) consume this same list — spectacle never replaces information.
//
// This module is deliberately pure: `compileBeats(events, opts)` given a
// full event stream returns the beat list + a mood value. Consumers hold the
// events in state and re-compile on each new event. This keeps the shape
// testable and lets us render both live and replay identically.

import type { UiEvent } from "./api.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type BeatMood =
  | "investigating"
  | "building"
  | "testing"
  | "stuck"
  | "triumphant"
  | "neutral";

export type BeatOutcome = "ok" | "error" | "pending";

export type BeatChapter =
  | { kind: "investigating"; label: "Investigating"; icon: "search"  }
  | { kind: "building";      label: "Building";      icon: "hammer"  }
  | { kind: "testing";       label: "Testing";       icon: "flask"   }
  | { kind: "verified";      label: "Verified";      icon: "check"   };

/** A single log entry rendered on screen. Every field is optional except
 *  `kind` + `id` + `ts` so the compiler can emit partial beats early and
 *  fill them in when the paired tool_result arrives. */
export interface Beat {
  id: string;
  ts: number;
  kind: "tool" | "text" | "flurry" | "chapter" | "test_result" | "error" | "meta";
  verb?: string;
  subject?: string;
  /** Short "why-line" — nearest preceding agent narration. */
  why?: string;
  outcome?: BeatOutcome;
  /** Coarse magnitude number for badges: line count, exit code, +/- lines. */
  magnitude?: number;
  /** Additional per-verb signals for renderers (exitCode, diff stats, etc.). */
  detail?: Record<string, string | number | boolean>;
  /** For flurry: original beats collapsed into this one. */
  members?: readonly Beat[];
  /** For chapter markers. */
  chapter?: BeatChapter["kind"];
  /** For error headlines. */
  errorClass?: "test-fail" | "crash" | "timeout" | "lint" | "generic";
  errorHeadline?: string;
  rawTail?: string;
  /** Extracted from test_result events. */
  passCount?: number;
  failCount?: number;
  duration?: number;
}

export interface CompiledFeed {
  beats: readonly Beat[];
  mood: BeatMood;
  /** Aggregate: total tool_calls, errors, ok in the compiled stream. */
  stats: {
    toolCalls: number;
    errors: number;
    successes: number;
    currentChapter: BeatChapter["kind"] | null;
    elapsedMs: number;
  };
}

// ─── Verb + subject extraction ───────────────────────────────────────────────

interface ParsedInput {
  verb: string;
  subject: string;
  magnitude?: number;
  detail: Record<string, string | number | boolean>;
}

/**
 * Turn a raw claude tool_use `input` JSON string into a display verb + subject.
 * Uses a well-known-tools table plus generic fallbacks. Never throws — a
 * malformed input just yields a plain "<tool> · <raw first arg>".
 *
 * Exported so tests can pin the extraction contract.
 */
export function parseToolInput(tool: string, inputJson: string | undefined): ParsedInput {
  const detail: Record<string, string | number | boolean> = {};
  let input: Record<string, unknown> = {};
  try { input = inputJson ? JSON.parse(inputJson) as Record<string, unknown> : {}; }
  catch { /* keep empty */ }

  const s = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === "string" ? v : undefined;
  };
  const n = (k: string): number | undefined => {
    const v = input[k];
    return typeof v === "number" ? v : undefined;
  };

  switch (tool) {
    case "Bash": {
      const cmd = s("command") ?? "";
      // Trim to the invocation, drop long tail flags for readability.
      const trimmed = cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
      return {
        verb: "bash",
        subject: trimmed || "(no command)",
        detail: cmd ? { command: cmd } : {},
      };
    }
    case "Read": {
      const path = s("file_path") ?? s("path") ?? "(no path)";
      const offset = n("offset");
      const limit  = n("limit");
      const subject = offset != null || limit != null
        ? `${basename(path)}:${offset ?? 1}${limit ? `–${(offset ?? 1) + limit}` : ""}`
        : basename(path);
      return {
        verb: "read",
        subject,
        magnitude: limit,
        detail: { path, ...(offset != null ? { offset } : {}), ...(limit != null ? { limit } : {}) },
      };
    }
    case "Write": {
      const path = s("file_path") ?? s("path") ?? "(no path)";
      const content = s("content") ?? "";
      const lines = content ? content.split("\n").length : 0;
      return {
        verb: "write",
        subject: basename(path),
        magnitude: lines,
        detail: { path, lines },
      };
    }
    case "Edit":
    case "MultiEdit": {
      const path = s("file_path") ?? s("path") ?? "(no path)";
      const oldStr = s("old_string") ?? "";
      const newStr = s("new_string") ?? "";
      const removed = oldStr ? oldStr.split("\n").length : 0;
      const added   = newStr ? newStr.split("\n").length : 0;
      return {
        verb: "edit",
        subject: basename(path),
        detail: { path, added, removed },
      };
    }
    case "Glob": {
      const pattern = s("pattern") ?? "?";
      return { verb: "glob", subject: pattern, detail: { pattern } };
    }
    case "Grep": {
      const pattern = s("pattern") ?? "?";
      const path = s("path") ?? "";
      const output = s("output_mode") ?? "";
      return {
        verb: "grep",
        subject: path ? `"${pattern}" in ${basename(path)}` : `"${pattern}"`,
        detail: { pattern, ...(path ? { path } : {}), ...(output ? { output } : {}) },
      };
    }
    case "WebFetch":
    case "WebSearch": {
      const url = s("url") ?? s("query") ?? "";
      return {
        verb: tool === "WebFetch" ? "fetch" : "search",
        subject: url ? url : "(no query)",
        detail: url ? { url } : {},
      };
    }
    case "Task": {
      const desc = s("description") ?? s("prompt")?.slice(0, 60) ?? "subagent";
      const agent = s("subagent_type") ?? "general-purpose";
      return {
        verb: "spawn",
        subject: `${agent} · ${desc}`,
        detail: { agent, description: desc },
      };
    }
    default:
      // ask_human / other MCP tools / user-defined subagents.
      if (tool === "ask_human" || tool.endsWith("__ask_human")) {
        const q = s("question") ?? "";
        return { verb: "ask", subject: q.slice(0, 100), detail: q ? { question: q } : {} };
      }
      // Generic fallback: pick the first non-empty string field.
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === "string" && v.trim()) {
          return { verb: tool.toLowerCase(), subject: v.slice(0, 80), detail: { [k]: v } };
        }
      }
      return { verb: tool.toLowerCase(), subject: "", detail: {} };
  }
}

// ─── Result parsing for outcomes + magnitudes ────────────────────────────────

interface ParsedResult {
  outcome: BeatOutcome;
  detail: Record<string, string | number | boolean>;
  errorClass?: Beat["errorClass"];
  errorHeadline?: string;
  rawTail?: string;
  magnitude?: number;
}

export function parseToolResult(tool: string, content: string | undefined, isError: boolean): ParsedResult {
  if (!content) {
    return { outcome: isError ? "error" : "ok", detail: {} };
  }

  // Bash tool_result surfaces stdout / exit code inline in claude's stream.
  if (tool === "Bash") {
    const exitMatch = content.match(/(?:^|\n)(?:exit\s*(?:code)?[:\s]*|Exited with code\s+)(-?\d+)/i);
    const exitCode = exitMatch ? Number(exitMatch[1]) : (isError ? 1 : 0);
    const failure = isError || exitCode !== 0;
    const head = failure ? extractErrorHeadline(content) : undefined;
    return {
      outcome: failure ? "error" : "ok",
      detail: { exitCode },
      errorClass: failure ? classifyError(content) : undefined,
      errorHeadline: head,
      rawTail: failure ? content.slice(-400) : undefined,
    };
  }

  if (tool === "Read") {
    // Claude often echoes the file with `cat -n` — magnitude is that count.
    const lastLine = content.trimEnd().split("\n").at(-1) ?? "";
    const lineMatch = lastLine.match(/^\s*(\d+)\s+/);
    const lines = lineMatch ? Number(lineMatch[1]) : undefined;
    return { outcome: isError ? "error" : "ok", detail: {}, magnitude: lines };
  }

  if (isError) {
    return {
      outcome: "error",
      detail: {},
      errorClass: classifyError(content),
      errorHeadline: extractErrorHeadline(content),
      rawTail: content.slice(-400),
    };
  }

  return { outcome: "ok", detail: {} };
}

function extractErrorHeadline(text: string): string {
  // Prefer typed exceptions (TypeError / ReferenceError / …) over decorative
  // FAIL / ✗ banners — the typed line carries diagnostic value.
  const priorityPatterns: RegExp[] = [
    /^(?:\S+:)?\s*(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|Panic|Exception)[^:]*:\s+.+$/,
    /^Error:\s+.+$/,
    /^error(?:\[\S+\])?:\s+.+$/i,
  ];
  const fallbackPatterns: RegExp[] = [
    /^(?:FAIL|FAILED|✗)\s+.+$/,
  ];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const p of priorityPatterns) {
    const hit = lines.find((l) => p.test(l));
    if (hit) return hit;
  }
  for (const p of fallbackPatterns) {
    const hit = lines.find((l) => p.test(l));
    if (hit) return hit;
  }
  for (const line of lines) {
    if (!/^[=─-]+$/.test(line)) return line;
  }
  return "(error with no message)";
}

function classifyError(text: string): Beat["errorClass"] {
  if (/timed out|TimeoutError|deadline exceeded/i.test(text)) return "timeout";
  if (/^\s*(FAIL|✗|expected|received|AssertionError)/im.test(text)) return "test-fail";
  if (/^SyntaxError|^ReferenceError|^TypeError|panicked|core dumped/im.test(text)) return "crash";
  if (/(eslint|biome|prettier|lint(er)?)/i.test(text) && /error/i.test(text)) return "lint";
  return "generic";
}

// ─── Chapter inference ───────────────────────────────────────────────────────

/**
 * Chapter is a rolling window over the last N tool verbs. Read/Grep/Glob-heavy
 * → investigating. Write/Edit-heavy → building. test_result / Bash-test →
 * testing. When a test_result passes and nothing new arrives → verified.
 *
 * Exported for tests.
 */
export function inferChapter(recentVerbs: readonly string[], lastTestPassed: boolean | null): BeatChapter["kind"] {
  if (lastTestPassed === true && recentVerbs.slice(-3).every((v) => v === "test_result" || v === "meta")) {
    return "verified";
  }
  const window = recentVerbs.slice(-6);
  const investigative = window.filter((v) => v === "read" || v === "grep" || v === "glob" || v === "fetch" || v === "search").length;
  const building      = window.filter((v) => v === "write" || v === "edit" || v === "bash").length;
  const testing       = window.filter((v) => v === "test_result").length;

  if (testing >= 1) return "testing";
  if (building > investigative) return "building";
  return "investigating";
}

// ─── Mood inference ──────────────────────────────────────────────────────────

/**
 * Mood color-temp signal, drives Scout + theme accents. Slightly hysteretic:
 *   • two consecutive errors → stuck (until a pass)
 *   • test_result passed → triumphant (for the next few beats)
 *   • else derived from chapter
 */
export function inferMood(beats: readonly Beat[]): BeatMood {
  if (beats.length === 0) return "neutral";
  const last = beats.slice(-8);
  const consecutiveErrors = last.slice(-3).filter((b) => b.outcome === "error").length;
  if (consecutiveErrors >= 2) return "stuck";
  const recentTest = [...last].reverse().find((b) => b.kind === "test_result");
  if (recentTest && recentTest.outcome === "ok") return "triumphant";
  const chapter = last.at(-1)?.chapter ?? "investigating";
  switch (chapter) {
    case "investigating": return "investigating";
    case "building":      return "building";
    case "testing":       return "testing";
    case "verified":      return "triumphant";
  }
}

// ─── Grouping (F1.3) ─────────────────────────────────────────────────────────

const FLURRY_THRESHOLD_EVENTS_PER_S = 6;
const FLURRY_WINDOW_MS = 1000;
const COLLAPSE_MIN_SAME_VERB = 2;

/** Group consecutive same-verb tool beats. Bursts >6 events/s collapse into a
 *  single "flurry" beat with count + members. */
export function groupBeats(beats: readonly Beat[]): readonly Beat[] {
  if (beats.length === 0) return beats;
  const out: Beat[] = [];
  let i = 0;
  while (i < beats.length) {
    const cur = beats[i]!;
    if (cur.kind !== "tool") { out.push(cur); i++; continue; }

    // Look ahead — if we have a burst of any tool beats within FLURRY_WINDOW_MS,
    // collapse them into a flurry regardless of verb.
    let j = i + 1;
    while (j < beats.length && beats[j]!.kind === "tool" && (beats[j]!.ts - cur.ts) <= FLURRY_WINDOW_MS) j++;
    const burst = beats.slice(i, j);
    const rateHz = burst.length / Math.max(1, (burst.at(-1)!.ts - burst[0]!.ts)) * 1000;
    if (burst.length >= 4 && rateHz >= FLURRY_THRESHOLD_EVENTS_PER_S) {
      out.push({
        id: `flurry-${cur.id}`,
        ts: cur.ts,
        kind: "flurry",
        verb: "flurry",
        subject: `${burst.length} rapid tool calls (${rateHz.toFixed(1)}/s)`,
        members: burst,
      });
      i = j;
      continue;
    }

    // Otherwise collapse a run of the same verb.
    let k = i + 1;
    while (
      k < beats.length &&
      beats[k]!.kind === "tool" &&
      beats[k]!.verb === cur.verb
    ) k++;
    const run = beats.slice(i, k);
    if (run.length >= COLLAPSE_MIN_SAME_VERB) {
      out.push({
        id: `group-${cur.id}`,
        ts: cur.ts,
        kind: "tool",
        verb: cur.verb,
        subject: `${cur.verb} ×${run.length} — ${run.map((b) => b.subject).filter(Boolean).slice(0, 3).join(", ")}${run.length > 3 ? "…" : ""}`,
        outcome: run.every((b) => b.outcome === "ok") ? "ok" : run.some((b) => b.outcome === "error") ? "error" : "pending",
        members: run,
      });
      i = k;
    } else {
      out.push(cur);
      i++;
    }
  }
  return out;
}

// ─── The compiler ────────────────────────────────────────────────────────────

export interface CompileOpts {
  startedAt?: number;
  /** Enable smart grouping (F1.3). On by default; off in tests. */
  group?: boolean;
}

export function compileBeats(
  events: readonly UiEvent[],
  opts: CompileOpts = {},
): CompiledFeed {
  const startedAt = opts.startedAt ?? Date.now();
  const raw: Beat[] = [];
  const pendingByToolUse = new Map<string, Beat>();
  const chapterHistory: string[] = [];
  let lastNarration: { text: string; ts: number } | null = null;
  let lastTestPassed: boolean | null = null;
  let currentChapter: BeatChapter["kind"] | null = null;
  let toolCalls = 0, errors = 0, successes = 0;

  const now = () => Date.now();

  events.forEach((e, idx) => {
    const ts = now(); // Timestamps aren't in the SSE payload; sequence order is enough.
    if (e.type === "text") {
      const t = e.text.trim();
      if (!t) return;
      lastNarration = { text: t, ts };
      raw.push({ id: `t-${idx}`, ts, kind: "text", subject: t, verb: "text" });
    } else if (e.type === "tool_call") {
      toolCalls++;
      const parsed = parseToolInput(e.tool, e.input);
      const beat: Beat = {
        id: `tool-${idx}`,
        ts,
        kind: "tool",
        verb: parsed.verb,
        subject: parsed.subject,
        outcome: "pending",
        magnitude: parsed.magnitude,
        detail: { tool: e.tool, ...parsed.detail },
        why: lastNarration?.text.slice(0, 140),
      };
      raw.push(beat);
      chapterHistory.push(parsed.verb);
      if (e.toolUseId) pendingByToolUse.set(e.toolUseId, beat);
    } else if (e.type === "tool_result") {
      const beat = e.toolUseId ? pendingByToolUse.get(e.toolUseId) : undefined;
      // Attach outcome to the paired tool_call beat.
      const tool = beat?.detail?.["tool"] as string | undefined;
      const parsed = parseToolResult(tool ?? "unknown", e.content, e.isError);
      if (beat) {
        beat.outcome = parsed.outcome;
        beat.detail = { ...beat.detail, ...parsed.detail };
        if (parsed.errorClass)    beat.errorClass    = parsed.errorClass;
        if (parsed.errorHeadline) beat.errorHeadline = parsed.errorHeadline;
        if (parsed.rawTail)       beat.rawTail       = parsed.rawTail;
        if (parsed.magnitude !== undefined && beat.magnitude === undefined) beat.magnitude = parsed.magnitude;
      }
      if (parsed.outcome === "ok") successes++; else if (parsed.outcome === "error") errors++;
    } else if (e.type === "test_result") {
      lastTestPassed = e.passed;
      chapterHistory.push("test_result");
      raw.push({
        id: `test-${idx}`,
        ts,
        kind: "test_result",
        verb: "test",
        outcome: e.passed ? "ok" : "error",
        subject: e.passed ? `Tests green (exit ${e.exitCode})` : `Tests red (exit ${e.exitCode})`,
        passCount: countMatch(e.output, /(\d+)\s+pass/i),
        failCount: countMatch(e.output, /(\d+)\s+fail/i),
        rawTail: e.output.slice(-400),
        errorClass: e.passed ? undefined : "test-fail",
      });
      if (e.passed) successes++; else errors++;
    } else if (e.type === "execution_complete") {
      raw.push({
        id: `done-${idx}`,
        ts,
        kind: "meta",
        verb: "complete",
        subject: `Execution ${e.status}`,
        outcome: e.status === "completed" ? "ok" : "error",
      });
    } else if (e.type === "awaiting_human") {
      raw.push({
        id: `ask-${idx}`,
        ts,
        kind: "meta",
        verb: "awaiting_human",
        subject: "Awaiting your decision",
        outcome: "pending",
      });
    }
  });

  // Chapter walk — advance whenever the rolling window changes chapter.
  for (const b of raw) {
    const idx = chapterHistory.indexOf(b.verb ?? "");
    if (idx >= 0) {
      const win = chapterHistory.slice(0, idx + 1);
      const next = inferChapter(win, lastTestPassed);
      if (next !== currentChapter) {
        currentChapter = next;
        b.chapter = next;
      }
    }
  }

  const grouped = opts.group === false ? raw : groupBeats(raw);
  const mood = inferMood(grouped);
  return {
    beats: grouped,
    mood,
    stats: {
      toolCalls,
      errors,
      successes,
      currentChapter,
      elapsedMs: raw.length ? (raw.at(-1)!.ts - startedAt) : 0,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function countMatch(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  return m ? Number(m[1]) : undefined;
}
