/**
 * Thin wrapper around `claude -p` for easy mocking in tests.
 * Returns the raw text result from Claude's response.
 */
export async function runClaudePlanner(prompt: string): Promise<string> {
  if (!Bun.which("claude")) {
    throw new Error(
      "claude CLI not found in PATH — install from https://claude.ai/download and run `claude login`",
    );
  }

  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "json", "--no-session-persistence"],
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

  // --output-format json wraps result in { result: "...", ... }
  try {
    const wrapper = JSON.parse(stdout) as { result?: string };
    if (typeof wrapper.result === "string") return wrapper.result;
  } catch { /* fall through to raw text */ }

  return stdout;
}
