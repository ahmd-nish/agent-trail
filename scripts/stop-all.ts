#!/usr/bin/env bun
/** Free inventarium's API + runner ports. Dev servers stay running (intentional). */
import { spawn } from "node:child_process";

const PORTS = [3002, 3003] as const;

async function free(port: number): Promise<{ port: number; killed: number }> {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", `lsof -ti:${port} 2>/dev/null | tee /dev/stderr | xargs -r kill -9 2>/dev/null; true`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killed = 0;
    p.stderr?.on("data", (chunk: Buffer) => {
      killed += chunk.toString().trim().split("\n").filter(Boolean).length;
    });
    p.on("close", () => resolve({ port, killed }));
  });
}

const results = await Promise.all(PORTS.map(free));
for (const r of results) {
  console.log(`port ${r.port}: ${r.killed} process${r.killed === 1 ? "" : "es"} terminated`);
}
console.log("\nDev servers spawned by the runner are detached and continue running.");
console.log("Use `bun status` to see which.");
