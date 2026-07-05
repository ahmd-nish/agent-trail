/**
 * Pure helper kept in the server: detect a sensible dev command + port from a
 * board's implementation_dir. The actual spawning and lifecycle now lives in
 * `packages/runner/` — the server proxies to it via HTTP.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function detectDevConfig(cwd: string): { command: string | null; port: number | null } {
  const pkgPath = join(cwd, "package.json");
  let command: string | null = null;
  let port: number | null = null;

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      const runner = deps["bun"] || existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb")) ? "bun"
                    : deps["pnpm"] ? "pnpm"
                    : deps["yarn"] ? "yarn"
                    : "npm";

      const scriptName =
        scripts["dev"] ? "dev"
        : scripts["start"] ? "start"
        : scripts["serve"] ? "serve"
        : null;
      if (scriptName) {
        command = `${runner} run ${scriptName}`;
        const m = scripts[scriptName]!.match(/(?:--port[\s=]+|PORT=)(\d{2,5})/);
        if (m) port = Number(m[1]);
      }
    } catch { /* malformed package.json */ }
  }

  // Common Python project shapes
  if (!command) {
    if (existsSync(join(cwd, "manage.py"))) command = "python manage.py runserver 0.0.0.0:8000";
    else if (existsSync(join(cwd, "main.py"))) command = "python main.py";
    else if (existsSync(join(cwd, "app.py"))) command = "python app.py";
  }

  return { command, port };
}
