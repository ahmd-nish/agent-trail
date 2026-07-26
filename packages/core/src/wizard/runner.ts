import { MODEL_FOR_TIER } from "../planner/models.ts";

/**
 * Wizard LLM call — Sonnet by default (user opted for a "strong model"), same
 * mock-first pattern as the planner. Tests set AGENT_TRAIL_IDEA_MOCK to either
 *   • raw JSON / markdown  (returned verbatim as the response), or
 *   • `file:<path>`        (contents of the file, useful for large fixtures).
 */
export async function runIdeaLLM(prompt: string): Promise<string> {
  const mock = process.env["AGENT_TRAIL_IDEA_MOCK"];
  if (mock) {
    if (mock.startsWith("file:")) {
      return await Bun.file(mock.slice(5)).text();
    }
    void prompt;
    return mock;
  }

  if (!Bun.which("claude")) {
    throw new Error(
      "claude CLI not found in PATH — install from https://claude.ai/download and run `claude login`",
    );
  }

  // Strong model for both stack-question generation AND PRD synthesis. Cost is
  // amortised over the whole build; a bad plan is much more expensive than
  // saving 10 cents on the plan itself.
  const model = MODEL_FOR_TIER.sonnet;
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", model, "--output-format", "json", "--no-session-persistence"],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    throw new Error(`claude exited ${exitCode}${stderr ? `: ${stderr.slice(0, 400)}` : ""}`);
  }

  try {
    const wrapper = JSON.parse(stdout) as { result?: string };
    if (typeof wrapper.result === "string") return wrapper.result;
  } catch { /* fall through */ }
  return stdout;
}
