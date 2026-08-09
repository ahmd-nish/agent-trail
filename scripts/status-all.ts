#!/usr/bin/env bun
/** Health-check each inventarium process and report what's running. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Service { name: string; url: string; }
const SERVICES: Service[] = [
  { name: "server", url: "http://localhost:3002/api/health" },
  { name: "runner", url: "http://localhost:3003/health" },
];

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

async function check(svc: Service): Promise<{ name: string; ok: boolean; latencyMs: number; info?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(svc.url, { signal: AbortSignal.timeout(1500) });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { name: svc.name, ok: false, latencyMs, info: `HTTP ${res.status}` };
    const body = await res.json() as { ok?: boolean; ts?: string; role?: string };
    return { name: svc.name, ok: true, latencyMs, info: body.role ?? "" };
  } catch (err) {
    return { name: svc.name, ok: false, latencyMs: Date.now() - start, info: err instanceof Error ? err.message : String(err) };
  }
}

const results = await Promise.all(SERVICES.map(check));
for (const r of results) {
  const mark = r.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`${mark}  ${r.name.padEnd(7)} ${r.latencyMs}ms  ${DIM}${r.info ?? ""}${RESET}`);
}

// Detached dev servers tracked by the runner
const stateFile = join(homedir(), ".inventarium", "runner-state.json");
if (existsSync(stateFile)) {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
      servers?: Record<string, { boardId: string; pid: number; port: number | null; command: string }>;
    };
    const servers = Object.values(state.servers ?? {});
    if (servers.length > 0) {
      console.log(`\n${DIM}Detached dev servers (tracked by runner):${RESET}`);
      for (const s of servers) {
        const aliveMark = (() => { try { process.kill(s.pid, 0); return `${GREEN}●${RESET}`; } catch { return `${RED}○${RESET}`; }})();
        console.log(`  ${aliveMark} pid ${s.pid} port ${s.port ?? "?"} board ${s.boardId.slice(0,8)}  ${DIM}${s.command}${RESET}`);
      }
    }
  } catch { /* malformed state file, ignore */ }
}
