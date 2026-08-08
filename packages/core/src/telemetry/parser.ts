import type {
  StreamEvent,
  StreamResultEvent,
} from "../types/stream-json.ts";
import type { TelemetryEventKind } from "../types/index.ts";

/**
 * PRD_OPEN_SOURCE 2.1 — stream-json compat layer.
 *
 * Version this parser bumps every time we accept a breaking change to the
 * claude-CLI stream-json schema. `packages/core/src/telemetry/fixtures/*.jsonl`
 * holds recorded lines for each parser version we support; the golden test
 * runs every fixture through the parser and fails if any recognised event
 * type stops parsing. That's our schema-drift alarm — a CLI upgrade that
 * broke us would flip red before landing.
 */
export const STREAM_JSON_PARSER_VERSION = "1.0.0";
export const SUPPORTED_CLAUDE_CODE_VERSIONS = [
  "1.x", // wildcard for the current 1.x line — bump when a breaking event lands
];

export interface ParsedTelemetry {
  kind: TelemetryEventKind;
  toolName: string | null;
  toolInput: string | null;
  toolResult: string | null;
  textContent: string | null;
  rawJson: string;
}

export function parseTelemetry(event: StreamEvent, raw: string): ParsedTelemetry | null {
  switch (event.type) {
    case "system":
      return {
        kind: "system",
        toolName: null,
        toolInput: null,
        toolResult: null,
        textContent: JSON.stringify({ model: event.model, cwd: event.cwd }),
        rawJson: raw,
      };

    case "assistant": {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          return {
            kind: "tool_call",
            toolName: block.name,
            toolInput: JSON.stringify(block.input),
            toolResult: null,
            textContent: null,
            rawJson: raw,
          };
        }
        if (block.type === "text" && block.text.trim()) {
          return {
            kind: "text",
            toolName: null,
            toolInput: null,
            toolResult: null,
            textContent: block.text,
            rawJson: raw,
          };
        }
        if (block.type === "thinking" && block.thinking.trim()) {
          return {
            kind: "thinking",
            toolName: null,
            toolInput: null,
            toolResult: null,
            textContent: block.thinking,
            rawJson: raw,
          };
        }
      }
      return null;
    }

    case "user": {
      const content = event.message.content[0];
      if (content?.type === "tool_result") {
        return {
          kind: "tool_result",
          toolName: null,
          toolInput: null,
          toolResult: content.content,
          textContent: null,
          rawJson: raw,
        };
      }
      return null;
    }

    case "result":
      if (event.is_error) {
        return {
          kind: "error",
          toolName: null,
          toolInput: null,
          toolResult: null,
          textContent: event.result,
          rawJson: raw,
        };
      }
      return null;

    default:
      return null;
  }
}

export function extractMetrics(result: StreamResultEvent) {
  // `totalInputTokens` keeps its original meaning — every input token billed,
  // cached or not. Four consumers (cost dashboard, bench, CLI, web) and 38 rows
  // of history depend on that, so it is not redefined here.
  //
  // What was missing is the breakdown: cache reads bill at ~0.10x and cache
  // writes at ~1.25x, so without these two fields cache-hit rate is
  // unmeasurable and §4.4's whole premise has no feedback signal
  // (knowledgelayer-v2 §2).
  const cacheRead = result.usage.cache_read_input_tokens ?? 0;
  const cacheCreation = result.usage.cache_creation_input_tokens ?? 0;
  return {
    durationMs: result.duration_ms,
    totalInputTokens: result.usage.input_tokens + cacheRead,
    /** Input tokens served from cache. Numerator of cache-hit rate. */
    cacheReadInputTokens: cacheRead,
    /** Input tokens written to cache at a premium. Cost of a breakpoint miss. */
    cacheCreationInputTokens: cacheCreation,
    totalOutputTokens: result.usage.output_tokens,
    numTurns: result.num_turns,
  };
}
