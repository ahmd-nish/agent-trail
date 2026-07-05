import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamEvent } from "../types/stream-json.ts";
import { parseTelemetry, extractMetrics, STREAM_JSON_PARSER_VERSION } from "./parser.ts";

// PRD_OPEN_SOURCE 2.1 — golden fixtures.
// If any bundled fixture stops parsing, `bun test` goes red — that's the
// early warning that a claude-CLI upgrade needs a parser bump. Adding a new
// fixture is the workflow: record one line-per-event JSONL, drop it in
// `fixtures/`, this test picks it up automatically.

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function readFixture(name: string): StreamEvent[] {
  const raw = readFileSync(join(FIXTURES_DIR, name), "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as StreamEvent);
}

describe("stream-json parser fixtures (PRD_OPEN_SOURCE 2.1)", () => {
  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".jsonl"));

  test("at least one fixture is bundled", () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  test("parser version is set", () => {
    expect(STREAM_JSON_PARSER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const name of fixtureNames) {
    test(`fixture ${name} — every event parses without throwing`, () => {
      const events = readFixture(name);
      expect(events.length).toBeGreaterThan(0);
      for (const ev of events) {
        // parseTelemetry only returns non-null for events it recognises. We
        // don't require every event to be recognised (init/system varies),
        // but for tool_use / tool_result / text / result we do.
        const parsed = parseTelemetry(ev, JSON.stringify(ev));
        if (ev.type === "assistant") {
          const content = (ev as { message: { content: Array<{ type: string }> } }).message.content;
          const hasTool = content.some((b) => b.type === "tool_use");
          const hasText = content.some((b) => b.type === "text");
          if (hasTool || hasText) expect(parsed).not.toBeNull();
        }
      }
    });

    test(`fixture ${name} — final result event yields sane metrics`, () => {
      const events = readFixture(name);
      const result = events.find((e) => (e as { type: string }).type === "result");
      if (!result) return; // some fixtures may not have a terminal event
      const m = extractMetrics(result as never);
      expect(m.totalInputTokens).toBeGreaterThan(0);
      expect(m.totalOutputTokens).toBeGreaterThan(0);
      expect(m.durationMs).toBeGreaterThan(0);
    });
  }
});
