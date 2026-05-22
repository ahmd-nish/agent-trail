import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TestRunResult {
  passed: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
}

type Runner = "bun" | "jest" | "vitest" | "pytest" | "npm";

function detectRunner(cwd: string): Runner {
  // Check package.json scripts.test
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const testScript = pkg.scripts?.["test"] ?? "";
      if (testScript.includes("jest")) return "jest";
      if (testScript.includes("vitest")) return "vitest";
      if (testScript.includes("pytest")) return "pytest";
      if (testScript.includes("bun test")) return "bun";
      // Has a test script — run it via npm/bun
      if (testScript) return "npm";
      // Check devDeps
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (deps["jest"]) return "jest";
      if (deps["vitest"]) return "vitest";
    } catch {
      // malformed package.json
    }
  }
  // Python project?
  if (
    existsSync(join(cwd, "pytest.ini")) ||
    existsSync(join(cwd, "conftest.py")) ||
    existsSync(join(cwd, "pyproject.toml"))
  ) {
    return "pytest";
  }
  // Default to bun
  return "bun";
}

function runnerCommand(runner: Runner): { cmd: string; args: string[] } {
  switch (runner) {
    case "bun":
      return { cmd: "bun", args: ["test"] };
    case "jest":
      return { cmd: "npx", args: ["jest", "--no-coverage"] };
    case "vitest":
      return { cmd: "npx", args: ["vitest", "run"] };
    case "pytest":
      return { cmd: "pytest", args: ["-v"] };
    case "npm":
      return { cmd: "bun", args: ["run", "test"] };
  }
}

export async function runTests(cwd: string): Promise<TestRunResult> {
  const runner = detectRunner(cwd);
  const { cmd, args } = runnerCommand(runner);
  const start = Date.now();

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];

    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    proc.on("error", (err) => {
      resolve({
        passed: false,
        exitCode: 1,
        output: `Failed to run ${cmd}: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });

    proc.on("close", (code) => {
      resolve({
        passed: code === 0,
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString("utf-8"),
        durationMs: Date.now() - start,
      });
    });
  });
}
