import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseTelemetry, extractMetrics } from "./parser.ts";
import type { StreamEvent, StreamResultEvent } from "../types/stream-json.ts";

// Locate the most recent probe-output directory. The probe script writes a
// dated folder under repo/probe-output and the JSONL inside is the authoritative
// shape of `claude --output-format stream-json` output we parse against.
function latestProbeDir(): string | null {
  const root = join(import.meta.dir, "../../../..", "probe-output");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  if (dirs.length === 0) return null;
  return join(root, dirs[dirs.length - 1]!);
}

function loadProbeEvents(): { raw: string; event: StreamEvent }[] {
  const dir = latestProbeDir();
  if (!dir) return [];
  const path = join(dir, "raw.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n");
  const events: { raw: string; event: StreamEvent }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("###")) continue;
    try {
      events.push({ raw: trimmed, event: JSON.parse(trimmed) as StreamEvent });
    } catch {
      // skip non-JSON / corrupted lines
    }
  }
  return events;
}

describe("parseTelemetry", () => {
  it("classifies a text-only assistant message as `text`", () => {
    const event: StreamEvent = {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        stop_reason: null,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
      parent_tool_use_id: null,
      session_id: "s1",
      uuid: "u1",
    };
    const result = parseTelemetry(event, JSON.stringify(event));
    expect(result?.kind).toBe("text");
    expect(result?.textContent).toBe("hello");
  });

  it("classifies tool_use as `tool_call` and captures name + input", () => {
    const event: StreamEvent = {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: "msg_2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash",
            input: { command: "ls" },
            caller: { type: "agent" },
          },
        ],
        stop_reason: null,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      session_id: "s",
      uuid: "u",
    };
    const result = parseTelemetry(event, JSON.stringify(event));
    expect(result?.kind).toBe("tool_call");
    expect(result?.toolName).toBe("Bash");
    expect(result?.toolInput).toContain("ls");
  });

  it("classifies user tool_result as `tool_result`", () => {
    const event: StreamEvent = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "done", is_error: false }],
      },
      parent_tool_use_id: null,
      session_id: "s",
      uuid: "u",
      timestamp: "2026-05-23T00:00:00Z",
      tool_use_result: "done",
    };
    const result = parseTelemetry(event, JSON.stringify(event));
    expect(result?.kind).toBe("tool_result");
    expect(result?.toolResult).toBe("done");
  });

  it("returns null for assistant messages with no useful content", () => {
    const event: StreamEvent = {
      type: "assistant",
      message: {
        model: "x", id: "x", role: "assistant",
        content: [{ type: "text", text: "   " }],
        stop_reason: null,
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null, session_id: "s", uuid: "u",
    };
    expect(parseTelemetry(event, "{}")).toBeNull();
  });

  it("classifies error result as `error` and ignores success result", () => {
    const errResult: StreamResultEvent = {
      type: "result", subtype: "error", is_error: true,
      api_error_status: null, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
      result: "boom", stop_reason: "end_turn", session_id: "s",
      total_cost_usd: 0,
      usage: {
        input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        output_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
      permission_denials: [], terminal_reason: "x", uuid: "u",
    };
    const okResult = { ...errResult, subtype: "success" as const, is_error: false };
    expect(parseTelemetry(errResult, "{}")?.kind).toBe("error");
    expect(parseTelemetry(okResult, "{}")).toBeNull();
  });
});

describe("parseTelemetry against locked probe fixtures", () => {
  const events = loadProbeEvents();
  const hasFixtures = events.length > 0;

  it("loaded at least one probe event (canary for fixture drift)", () => {
    // If this fails on CI, run `bun scripts/probe-claude-code.ts` and commit
    // the resulting probe-output/ directory.
    expect(events.length).toBeGreaterThan(0);
  });

  it("never throws on any probe event", () => {
    if (!hasFixtures) return;
    for (const { raw, event } of events) {
      expect(() => parseTelemetry(event, raw)).not.toThrow();
    }
  });

  it("every classified event has a valid kind", () => {
    if (!hasFixtures) return;
    const validKinds = new Set(["tool_call", "tool_result", "text", "thinking", "error", "system"]);
    for (const { raw, event } of events) {
      const result = parseTelemetry(event, raw);
      if (result) expect(validKinds.has(result.kind)).toBe(true);
    }
  });

  it("extractMetrics returns finite numbers for every result event", () => {
    if (!hasFixtures) return;
    const results = events.filter((e) => e.event.type === "result");
    for (const { event } of results) {
      const m = extractMetrics(event as StreamResultEvent);
      expect(Number.isFinite(m.durationMs)).toBe(true);
      expect(m.totalInputTokens).toBeGreaterThanOrEqual(0);
      expect(m.totalOutputTokens).toBeGreaterThanOrEqual(0);
    }
  });
});
