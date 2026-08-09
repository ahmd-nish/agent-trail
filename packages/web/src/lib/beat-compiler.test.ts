import { describe, test, expect } from "bun:test";
import {
  parseToolInput,
  parseToolResult,
  inferChapter,
  inferMood,
  groupBeats,
  compileBeats,
  type Beat,
} from "./beat-compiler.ts";
import type { UiEvent } from "./api.ts";

// PRD_FEED_EXPERIENCE §1 tests. The Beat Compiler is a pure function — if
// these assertions hold, every renderer downstream has clean data.

// ─── parseToolInput ──────────────────────────────────────────────────────────

describe("parseToolInput", () => {
  test("Bash → verb=bash + command as subject (truncated)", () => {
    const p = parseToolInput("Bash", JSON.stringify({ command: "bun test" }));
    expect(p.verb).toBe("bash");
    expect(p.subject).toBe("bun test");
    expect(p.detail).toEqual({ command: "bun test" });
  });

  test("Bash: very long command is truncated with ellipsis", () => {
    const long = "bun " + "x".repeat(200);
    const p = parseToolInput("Bash", JSON.stringify({ command: long }));
    expect(p.subject.length).toBeLessThanOrEqual(80);
    expect(p.subject.endsWith("…")).toBe(true);
  });

  test("Read: yields basename:offset–end", () => {
    const p = parseToolInput("Read", JSON.stringify({ file_path: "/a/b/server.ts", offset: 40, limit: 80 }));
    expect(p.verb).toBe("read");
    expect(p.subject).toBe("server.ts:40–120");
    expect(p.magnitude).toBe(80);
    expect(p.detail["path"]).toBe("/a/b/server.ts");
  });

  test("Read without offset/limit → basename only", () => {
    const p = parseToolInput("Read", JSON.stringify({ file_path: "/a/b/x.ts" }));
    expect(p.subject).toBe("x.ts");
  });

  test("Edit: reports added / removed line counts as detail", () => {
    const p = parseToolInput("Edit", JSON.stringify({
      file_path: "/foo/bar.ts",
      old_string: "line1\nline2",
      new_string: "line1\nline2\nline3\nline4",
    }));
    expect(p.verb).toBe("edit");
    expect(p.subject).toBe("bar.ts");
    expect(p.detail).toMatchObject({ added: 4, removed: 2 });
  });

  test("Grep: quotes the pattern + names the path", () => {
    const p = parseToolInput("Grep", JSON.stringify({ pattern: "TODO", path: "src/foo" }));
    expect(p.verb).toBe("grep");
    expect(p.subject).toBe(`"TODO" in foo`);
  });

  test("ask_human short-circuits to verb=ask + question as subject", () => {
    const p = parseToolInput("ask_human", JSON.stringify({ question: "Which port should I use?" }));
    expect(p.verb).toBe("ask");
    expect(p.subject).toContain("Which port");
  });

  test("mcp-namespaced ask_human matches by suffix", () => {
    const p = parseToolInput("mcp__inventarium__ask_human", JSON.stringify({ question: "Retry?" }));
    expect(p.verb).toBe("ask");
  });

  test("unknown tool with a string arg falls back to first string", () => {
    const p = parseToolInput("SomethingCustom", JSON.stringify({ text: "hello there" }));
    expect(p.verb).toBe("somethingcustom");
    expect(p.subject).toBe("hello there");
  });

  test("malformed JSON does not throw — returns a bare tool name", () => {
    const p = parseToolInput("Bash", "{not-json");
    expect(p.verb).toBe("bash");
    expect(p.subject).toBe("(no command)");
  });
});

// ─── parseToolResult ─────────────────────────────────────────────────────────

describe("parseToolResult", () => {
  test("Bash exit 0 → outcome ok + exitCode 0", () => {
    const r = parseToolResult("Bash", "hello world\nexit code: 0", false);
    expect(r.outcome).toBe("ok");
    expect(r.detail["exitCode"]).toBe(0);
  });

  test("Bash exit 1 → outcome error + errorClass generic + headline", () => {
    const output = `bun test\n\nTypeError: foo is not a function\n    at bar.ts:12\nexit code: 1`;
    const r = parseToolResult("Bash", output, false);
    expect(r.outcome).toBe("error");
    expect(r.detail["exitCode"]).toBe(1);
    expect(r.errorHeadline).toContain("TypeError");
    // Full crash class assertion below.
  });

  test("Bash test failure classifies as test-fail", () => {
    const output = `bun test\n\n FAIL src/foo.test.ts\n  ✗ works > returns 42\nexit code: 1`;
    const r = parseToolResult("Bash", output, false);
    expect(r.errorClass).toBe("test-fail");
  });

  test("timeout classifies as timeout", () => {
    const r = parseToolResult("Bash", "Command timed out after 120s", true);
    expect(r.errorClass).toBe("timeout");
  });

  test("crash keyword classifies as crash", () => {
    const r = parseToolResult("Bash", "thread 'main' panicked at 'bad thing'", true);
    expect(r.errorClass).toBe("crash");
  });

  test("lint failure classifies as lint", () => {
    const r = parseToolResult("Bash", "biome check\nerror: unused variable", true);
    expect(r.errorClass).toBe("lint");
  });
});

// ─── inferChapter ────────────────────────────────────────────────────────────

describe("inferChapter", () => {
  test("all reads → investigating", () => {
    expect(inferChapter(["read", "read", "grep", "read"], null)).toBe("investigating");
  });

  test("mostly writes/edits → building", () => {
    expect(inferChapter(["read", "write", "edit", "write", "edit"], null)).toBe("building");
  });

  test("test_result in window → testing", () => {
    expect(inferChapter(["read", "write", "test_result"], null)).toBe("testing");
  });

  test("recent green test + no new tools → verified", () => {
    expect(inferChapter(["test_result", "test_result"], true)).toBe("verified");
  });
});

// ─── inferMood ───────────────────────────────────────────────────────────────

describe("inferMood", () => {
  const b = (over: Partial<Beat> = {}): Beat => ({ id: "x", ts: 0, kind: "tool", ...over });

  test("empty beats → neutral", () => {
    expect(inferMood([])).toBe("neutral");
  });

  test("two consecutive errors → stuck", () => {
    expect(inferMood([b({ outcome: "error" }), b({ outcome: "error" })])).toBe("stuck");
  });

  test("last test_result ok → triumphant", () => {
    expect(inferMood([b({ kind: "test_result", outcome: "ok" }), b({ kind: "text" })])).toBe("triumphant");
  });

  test("last chapter investigating → investigating", () => {
    expect(inferMood([b({ chapter: "investigating" })])).toBe("investigating");
  });
});

// ─── groupBeats ──────────────────────────────────────────────────────────────

describe("groupBeats", () => {
  const b = (id: string, verb: string, ts: number, over: Partial<Beat> = {}): Beat =>
    ({ id, ts, kind: "tool", verb, subject: `${verb}-${id}`, ...over });

  test("three consecutive read beats collapse to one", () => {
    const grouped = groupBeats([
      b("1", "read", 100),
      b("2", "read", 300),
      b("3", "read", 700),
    ]);
    expect(grouped.length).toBe(1);
    expect(grouped[0]!.subject).toMatch(/read ×3/);
    expect(grouped[0]!.members?.length).toBe(3);
  });

  test("high-rate burst becomes a flurry regardless of verb", () => {
    // 5 events in 200ms → ~25/s > 6/s threshold.
    const beats: Beat[] = [
      b("1", "read",  0),
      b("2", "read",  40),
      b("3", "edit",  80),
      b("4", "read",  120),
      b("5", "write", 160),
    ];
    const grouped = groupBeats(beats);
    expect(grouped.length).toBe(1);
    expect(grouped[0]!.kind).toBe("flurry");
    expect(grouped[0]!.members?.length).toBe(5);
  });

  test("mixed verbs at low rate don't collapse", () => {
    const grouped = groupBeats([
      b("1", "read",  0),
      b("2", "edit", 1500),
      b("3", "bash", 3000),
    ]);
    expect(grouped.length).toBe(3);
  });

  test("non-tool beats (text, meta) pass through untouched", () => {
    const grouped = groupBeats([
      { id: "t1", ts: 0, kind: "text", subject: "hello" },
      b("1", "read", 100),
      { id: "m1", ts: 200, kind: "meta", verb: "complete", subject: "done" },
    ]);
    expect(grouped.length).toBe(3);
    expect(grouped[0]!.kind).toBe("text");
    expect(grouped[2]!.kind).toBe("meta");
  });
});

// ─── compileBeats end-to-end ─────────────────────────────────────────────────

describe("compileBeats", () => {
  test("real-world stream produces tools with why-line + outcome", () => {
    const events: UiEvent[] = [
      { type: "text", text: "Let me look at how the server starts." },
      { type: "tool_call", tool: "Read", toolUseId: "u1", input: JSON.stringify({ file_path: "server.ts" }) },
      { type: "tool_result", toolUseId: "u1", isError: false, content: "1  hello\n2  world" },
      { type: "text", text: "Now let me run the tests." },
      { type: "tool_call", tool: "Bash", toolUseId: "u2", input: JSON.stringify({ command: "bun test" }) },
      { type: "tool_result", toolUseId: "u2", isError: false, content: "3 pass\nexit code: 0" },
      { type: "test_result", passed: true, exitCode: 0, output: "3 pass" },
    ];
    const { beats, mood, stats } = compileBeats(events, { group: false });
    expect(beats.length).toBe(events.length - 2); // tool_result attaches to its tool_call
    const readBeat = beats.find((b) => b.verb === "read")!;
    expect(readBeat.subject).toBe("server.ts");
    expect(readBeat.outcome).toBe("ok");
    expect(readBeat.why).toContain("how the server starts");
    const bashBeat = beats.find((b) => b.verb === "bash")!;
    expect(bashBeat.outcome).toBe("ok");
    expect(bashBeat.detail?.["exitCode"]).toBe(0);
    expect(mood).toBe("triumphant");
    expect(stats.toolCalls).toBe(2);
    expect(stats.errors).toBe(0);
  });

  test("failing Bash carries error headline + class", () => {
    const events: UiEvent[] = [
      { type: "tool_call", tool: "Bash", toolUseId: "u1", input: JSON.stringify({ command: "bun test" }) },
      { type: "tool_result", toolUseId: "u1", isError: false, content:
        `bun test\n\n FAIL src/x.test.ts\n  ✗ works\nTypeError: undefined port\n    at server.ts:88\nexit code: 1` },
    ];
    const { beats } = compileBeats(events, { group: false });
    const bash = beats[0]!;
    expect(bash.outcome).toBe("error");
    expect(bash.errorHeadline).toContain("TypeError");
    expect(bash.errorClass).toBe("test-fail");
  });

  test("execution_complete + awaiting_human appear as meta beats", () => {
    const events: UiEvent[] = [
      { type: "awaiting_human", executionId: "e1" },
      { type: "execution_complete", status: "completed", executionId: "e1" },
    ];
    const { beats } = compileBeats(events, { group: false });
    expect(beats[0]!.kind).toBe("meta");
    expect(beats[0]!.verb).toBe("awaiting_human");
    expect(beats[1]!.verb).toBe("complete");
  });

  test("grouping on by default when compileBeats called without opts", () => {
    const events: UiEvent[] = [
      { type: "tool_call", tool: "Read", toolUseId: "u1", input: JSON.stringify({ file_path: "a.ts" }) },
      { type: "tool_call", tool: "Read", toolUseId: "u2", input: JSON.stringify({ file_path: "b.ts" }) },
      { type: "tool_call", tool: "Read", toolUseId: "u3", input: JSON.stringify({ file_path: "c.ts" }) },
    ];
    const { beats } = compileBeats(events);
    expect(beats.length).toBe(1);
    expect(beats[0]!.subject).toMatch(/read ×3/);
  });
});
