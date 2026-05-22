#!/usr/bin/env bun
/**
 * Probe script: run claude CLI with --output-format stream-json across four
 * scenarios and capture raw output for inspection. This de-risks the Day 4
 * stream-json parser by pinning real event shapes before we write code against them.
 *
 * Usage:  bun scripts/probe-claude-code.ts
 * Output: probe-output/<timestamp>/{raw.jsonl, summary.json, report.md}
 *
 * Cost: ~$0.10 in API usage.
 * Requires: `claude` CLI installed and authenticated.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

interface ProbeScenario {
  name: string;
  prompt: string;
  expectFailure?: boolean;
}

const scenarios: ProbeScenario[] = [
  {
    name: "simple-text",
    prompt: "Reply with exactly: hello from agent-trail probe",
  },
  {
    name: "single-tool-call",
    prompt: "What is 2 + 2? Use the calculator if you have it, otherwise just tell me.",
  },
  {
    name: "multi-step",
    prompt: "List the files in the current directory, then tell me how many there are.",
  },
  {
    name: "expected-failure",
    prompt: "Read the file /nonexistent/path/that/does/not/exist.txt",
    expectFailure: true,
  },
];

interface EventSummary {
  type: string;
  subtype?: string;
  hasToolUse?: boolean;
  hasToolResult?: boolean;
  hasText?: boolean;
}

async function runScenario(
  scenario: ProbeScenario,
  outputDir: string,
): Promise<{ events: EventSummary[]; rawLines: string[]; durationMs: number }> {
  const start = Date.now();
  const rawLines: string[] = [];

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "-p",
      scenario.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) rawLines.push(trimmed);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) rawLines.push(`STDERR: ${text}`);
    });

    proc.on("close", (code) => {
      const durationMs = Date.now() - start;
      const events: EventSummary[] = [];

      for (const line of rawLines) {
        if (line.startsWith("STDERR:")) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const summary: EventSummary = {
            type: (parsed["type"] as string) ?? "unknown",
            subtype: parsed["subtype"] as string | undefined,
          };
          if (parsed["type"] === "content_block_start") {
            const block = parsed["content_block"] as Record<string, unknown> | undefined;
            if (block?.["type"] === "tool_use") summary.hasToolUse = true;
            if (block?.["type"] === "text") summary.hasText = true;
          }
          if (parsed["type"] === "tool_result") summary.hasToolResult = true;
          events.push(summary);
        } catch {
          // non-JSON line — likely a status message or stderr
        }
      }

      if (code !== 0 && !scenario.expectFailure) {
        console.warn(`  [WARN] scenario "${scenario.name}" exited with code ${code}`);
      }

      resolve({ events, rawLines, durationMs });
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}. Is it installed and on PATH?`));
    });
  });
}

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputDir = join("probe-output", timestamp);

  await mkdir(outputDir, { recursive: true });

  console.log(`\nagent-trail probe — ${timestamp}`);
  console.log(`Output dir: ${outputDir}\n`);

  const allRawLines: string[] = [];
  const report: string[] = [
    `# agent-trail probe report`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
  ];

  const summaryData: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    scenarios: {},
  };

  for (const scenario of scenarios) {
    console.log(`Running: ${scenario.name}...`);

    allRawLines.push(`\n### SCENARIO: ${scenario.name} ###`);
    report.push(`## ${scenario.name}`);
    report.push(``);
    report.push(`**Prompt:** \`${scenario.prompt}\``);
    report.push(``);

    try {
      const result = await runScenario(scenario, outputDir);

      allRawLines.push(...result.rawLines);

      report.push(`**Duration:** ${result.durationMs}ms`);
      report.push(``);
      report.push(`**Raw line count:** ${result.rawLines.length}`);
      report.push(``);
      report.push(`**Event types seen:**`);
      report.push(``);

      const typeCounts: Record<string, number> = {};
      for (const ev of result.events) {
        const key = ev.subtype ? `${ev.type}.${ev.subtype}` : ev.type;
        typeCounts[key] = (typeCounts[key] ?? 0) + 1;
      }

      for (const [type, count] of Object.entries(typeCounts)) {
        report.push(`- \`${type}\` × ${count}`);
      }
      report.push(``);

      // print first few raw lines for context
      report.push(`**First 5 raw lines:**`);
      report.push(``);
      report.push("```json");
      for (const line of result.rawLines.slice(0, 5)) {
        report.push(line);
      }
      report.push("```");
      report.push(``);

      (summaryData["scenarios"] as Record<string, unknown>)[scenario.name] = {
        durationMs: result.durationMs,
        rawLineCount: result.rawLines.length,
        eventTypeCounts: typeCounts,
        expectedFailure: scenario.expectFailure ?? false,
      };

      console.log(`  Done in ${result.durationMs}ms — ${result.rawLines.length} lines`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.push(`**ERROR:** ${msg}`);
      report.push(``);
      (summaryData["scenarios"] as Record<string, unknown>)[scenario.name] = { error: msg };
      console.error(`  ERROR: ${msg}`);
    }
  }

  await writeFile(join(outputDir, "raw.jsonl"), allRawLines.join("\n"), "utf-8");
  await writeFile(join(outputDir, "summary.json"), JSON.stringify(summaryData, null, 2), "utf-8");
  await writeFile(join(outputDir, "report.md"), report.join("\n"), "utf-8");

  console.log(`\nProbe complete.`);
  console.log(`  raw.jsonl   — all raw output lines`);
  console.log(`  summary.json — structured summary`);
  console.log(`  report.md   — human-readable report (share this back)`);
  console.log(`\nShare probe-output/${timestamp}/report.md to lock the Day 4 parser types.\n`);
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
