#!/usr/bin/env bun
/**
 * One-shot launcher: brings up runner + server in one terminal, with combined
 * output prefixed by role. Ctrl-C cleanly terminates both. Dev-server children
 * spawned by the runner survive (they run detached in their own process group).
 *
 * Process layout once this is up:
 *
 *   start-all.ts (this process)
 *   ├─ inventarium runner   :3003   (owns dev server children)
 *   │   └─ <dev servers, detached, not in this tree>
 *   └─ inventarium server   :3002   (Hono REST + SSE, talks to runner via HTTP)
 *
 * Anything that hangs/crashes in one role does NOT take down the other.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

interface Service {
  name: string;
  color: string;
  command: string;
  args: string[];
  port: number;
}

const SERVICES: Service[] = [
  // Runner starts first so the server can talk to it on first request.
  { name: "runner", color: "\x1b[35m", command: "bun", args: ["run", "-F", "@inventarium/runner", "dev"], port: 3003 },
  { name: "server", color: "\x1b[36m", command: "bun", args: ["run", "dev:server"], port: 3002 },
];

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function prefix(s: Service): string {
  return `${s.color}[${s.name.padEnd(7)}]${RESET}`;
}

async function freePort(port: number): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", `lsof -ti:${port} | xargs -r kill -9 2>/dev/null; true`], { stdio: "ignore" });
    p.on("close", () => resolve());
  });
}

async function main() {
  console.log(`${DIM}freeing ports before start…${RESET}`);
  await Promise.all(SERVICES.map((s) => freePort(s.port)));

  const procs: { svc: Service; proc: ChildProcess }[] = [];
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals | "exit") => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${DIM}\nstopping inventarium (${signal})…${RESET}`);
    for (const { svc, proc } of procs) {
      if (!proc.killed) {
        try { proc.kill("SIGTERM"); }
        catch { /* gone */ }
        console.log(`${prefix(svc)} ${DIM}SIGTERM${RESET}`);
      }
    }
    setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 0), 1500);
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => shutdown(sig));
  }

  for (const svc of SERVICES) {
    const proc = spawn(svc.command, svc.args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1" },
    });
    procs.push({ svc, proc });

    proc.stdout?.setEncoding("utf-8");
    proc.stderr?.setEncoding("utf-8");

    const pipe = (stream: "stdout" | "stderr") => (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        const tag = stream === "stderr" ? `\x1b[31m✗${RESET}` : " ";
        process.stdout.write(`${prefix(svc)} ${tag} ${line}\n`);
      }
    };
    proc.stdout?.on("data", pipe("stdout"));
    proc.stderr?.on("data", pipe("stderr"));

    proc.on("exit", (code, sigArg) => {
      if (shuttingDown) return;
      console.log(`${prefix(svc)} ${DIM}exited (code=${code} signal=${sigArg ?? "-"})${RESET}`);
      // If one role dies, take down the other so the user notices.
      shutdown("exit");
    });
  }

  // Light delay between starts so logs land in a sensible order.
  // (Bun won't actually serialize the spawns above, but giving the runner a
  // moment to bind avoids a "Runner unreachable" warning on the server's first poll.)
}

main();
