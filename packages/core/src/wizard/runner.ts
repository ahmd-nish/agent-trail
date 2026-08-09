import { MODEL_FOR_TIER, type ModelTier } from "../planner/models.ts";

/**
 * Wizard LLM call — defaults to Opus (top-of-ladder) so the plan is the
 * highest-quality output; caller may downshift for cheaper runs. Same
 * mock-first pattern as the planner. Tests set INVENTARIUM_IDEA_MOCK to either
 *   • raw JSON / markdown  (returned verbatim as the response), or
 *   • `file:<path>`        (contents of the file, useful for large fixtures).
 */
export async function runIdeaLLM(prompt: string, tier: ModelTier = "opus"): Promise<string> {
  const mock = process.env["INVENTARIUM_IDEA_MOCK"];
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

  const model = MODEL_FOR_TIER[tier];
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
