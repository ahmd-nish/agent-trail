import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// ─────────────────────────────────────────────────────────────────────────────
// THE REAL-STACK TEST.
//
// Every high-severity bug found in this system so far was invisible to a fully
// green unit suite and obvious within minutes of running the actual product:
//
//   · thrash normalize     — sliced before substituting, so identical failures
//                            compared unequal (~1 in 4 misses)
//   · ETag collision       — two writes in one millisecond silently clobbered
//   · token underscore     — base64url secrets contain `_`, and the parser
//                            split on every one: HALF of all issued tokens
//                            failed to authenticate
//   · sync identity        — push read the remote workspace id against rows
//                            stamped 'local', so it pushed 0 and said "ok"
//   · CLI bootstrap        — created the events table but not knowledge_edges,
//                            so a teammate silently dropped every edge
//
// They share one cause: **unit tests construct their own database, their own
// identity, and their own wiring.** They never exercise the seams — migrations,
// CLI bootstrap, credential formats, config defaults — which is exactly where
// those five lived.
//
// So this test refuses to import helpers. It drives the REAL CLI as a
// subprocess and the REAL server as a process, the way a user does. It is
// slower than the rest of the suite on purpose; that cost is the point.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = join(import.meta.dir, "../../..");
const CLI = join(REPO, "packages/cli/src/index.ts");
const SERVER = join(import.meta.dir, "index.ts");

const MOCK = JSON.stringify({
  events: [{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }],
  final: "complete", inputTokens: 250, outputTokens: 90,
  cacheReadTokens: 800, cacheCreationTokens: 120, durationMs: 42,
});

function freeport(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.once("listening", () => {
      const a = srv.address();
      if (!a || typeof a === "string") { srv.close(); reject(new Error("no port")); return; }
      const p = a.port; srv.close(() => resolve(p));
    });
    srv.listen(0, "127.0.0.1");
  });
}

async function waitForHealth(port: number, ms = 25000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return true; }
    catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

/** Invoke the REAL CLI. Importing its functions instead is how the token-format
 *  and bootstrap bugs stayed hidden. */
function cli(args: string[], env: Record<string, string> = {}): { out: string; code: number } {
  const res = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { out: `${res.stdout ?? ""}${res.stderr ?? ""}`, code: res.status ?? -1 };
}

function startServer(opts: { port: number; root: string; dbPath: string; extra?: Record<string, string> }): ChildProcess {
  const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...clean } = process.env;
  return spawn("bun", [SERVER], {
    cwd: opts.root,
    env: {
      ...clean,
      INVENTARIUM_PORT: String(opts.port),
      INVENTARIUM_ROOT: opts.root,
      INVENTARIUM_DB_PATH: opts.dbPath,
      INVENTARIUM_SKIP_RUNNER: "1",
      INVENTARIUM_SKIP_AUTOSYNC: "1",
      INVENTARIUM_SKIP_HYDRATE: "1",
      ...(opts.extra ?? {}),
    },
    stdio: "ignore",
  });
}

describe("REAL STACK — the seams unit tests never touch", () => {
  let relay: ChildProcess | undefined;
  let alice: ChildProcess | undefined;
  let base = "";
  let relayPort = 0;
  let alicePort = 0;
  let relayDb = "";
  let aliceDb = "";
  let bobDb = "";
  let aliceToken = "";
  let bobToken = "";
  let remote = "";

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "at-realstack-"));
    relayDb = join(base, "relay", "relay.db");
    aliceDb = join(base, "alice", "inventarium.db");
    bobDb = join(base, "bob", "bob.db");
    mkdirSync(join(base, "relay"), { recursive: true });
    mkdirSync(join(base, "alice", "work", "src"), { recursive: true });
    mkdirSync(join(base, "bob"), { recursive: true });

    // A deliberately red suite, so verify_tests fails and emits knowledge.
    writeFileSync(join(base, "alice/work/package.json"),
      JSON.stringify({ name: "rs", type: "module", scripts: { test: "bun test" } }), "utf8");
    writeFileSync(join(base, "alice/work/src/auth.ts"),
      "export function login(u: string): boolean { return false }\n", "utf8");
    writeFileSync(join(base, "alice/work/auth.test.ts"),
      `import { test, expect } from "bun:test";\ntest("login works", () => { expect(1).toBe(2); });\n`, "utf8");

    relayPort = await freeport();
    relay = startServer({ port: relayPort, root: join(base, "relay"), dbPath: relayDb });
    if (!await waitForHealth(relayPort)) throw new Error("relay did not start");
    remote = `http://localhost:${relayPort}`;

    alicePort = await freeport();
    alice = startServer({
      port: alicePort, root: join(base, "alice"), dbPath: aliceDb,
      extra: { INVENTARIUM_CLAUDE_MOCK: MOCK },
    });
    if (!await waitForHealth(alicePort)) throw new Error("alice board did not start");
  }, 90_000);

  afterAll(async () => {
    relay?.kill("SIGTERM");
    alice?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("1. identity is provisioned through the real CLI", () => {
    const env = { INVENTARIUM_DB_PATH: relayDb };
    expect(cli(["workspace", "create", "acme", "Acme"], env).code).toBe(0);
    expect(cli(["workspace", "member", "add", "acme", "github:1", "Alice", "--role", "member"], env).code).toBe(0);
    expect(cli(["workspace", "member", "add", "acme", "github:2", "Bob", "--role", "member"], env).code).toBe(0);

    const a = cli(["workspace", "token", "create", "acme", "github:1", "--label", "alice"], env);
    const b = cli(["workspace", "token", "create", "acme", "github:2", "--label", "bob"], env);
    aliceToken = a.out.match(/at_[A-Za-z0-9_-]+/)?.[0] ?? "";
    bobToken = b.out.match(/at_[A-Za-z0-9_-]+/)?.[0] ?? "";
    expect(aliceToken).toStartWith("at_");
    expect(bobToken).toStartWith("at_");
  }, 60_000);

  test("2. a CLI-issued token is accepted over real HTTP", async () => {
    // Regression: base64url secrets contain `_` and the parser split on every
    // one, so ~half of all issued tokens were rejected as malformed. Only a
    // token that came out of the REAL CLI and went over the REAL wire proves
    // the format round-trips.
    const res = await fetch(`${remote}/v1/events?project=alice`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
  }, 30_000);

  test("3. a real board task emits knowledge with a file footprint", async () => {
    const api = async (method: string, path: string, body?: unknown) =>
      await (await fetch(`http://localhost:${alicePort}${path}`, {
        method, headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })).json();

    const board = await api("POST", "/api/boards", {
      name: "realstack", implementationDir: join(base, "alice/work"),
    }) as { id: string };
    const task = await api("POST", `/api/boards/${board.id}/tasks`, {
      title: "harden the login auth flow",
      tddEnabled: true, tddPhase: "verify_tests", modelTier: "sonnet",
      likelyPaths: ["src/auth.ts"],
    }) as { id: string };
    await api("POST", `/api/tasks/${task.id}/execute`);

    const deadline = Date.now() + 40_000;
    let rows: Array<{ paths: string }> = [];
    while (Date.now() < deadline) {
      const db = new Database(aliceDb, { readonly: true });
      try {
        rows = db.query("SELECT paths FROM knowledge_events WHERE type = 'failed_attempt'").all() as typeof rows;
      } catch { /* table may not exist yet */ }
      db.close();
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(rows.length).toBeGreaterThan(0);
    // Regression: `paths` was always [] because the emitter read the snake_case
    // column off a camelCase object. Empty paths means no edges, which means
    // no governance gate and no §J join.
    expect(JSON.parse(rows[0]!.paths)).toEqual(["src/auth.ts"]);
  }, 90_000);

  test("4. sync pushes through the real CLI — not a cheerful zero", () => {
    // Regression: events are emitted with workspace_id='local', but push read
    // using the REMOTE workspace id, matched nothing, and printed
    // "+ pushed 0 event(s)" — a no-op indistinguishable from success.
    //
    // `--workspace acme` is load-bearing in this test. Without it the remote
    // and local ids BOTH default to "local", they coincide, and the bug cannot
    // manifest — which is exactly how the first version of this test passed
    // against the broken code.
    const res = cli(
      ["knowledge", "sync", "--remote", remote, "--workspace", "acme", "--project", "alice", "--token", aliceToken],
      { INVENTARIUM_DB_PATH: aliceDb },
    );
    expect(res.code).toBe(0);
    const pushed = Number(res.out.match(/pushed (\d+) event/)?.[1] ?? "0");
    expect(pushed).toBeGreaterThan(0);
  }, 60_000);

  test("5. a brand-new teammate bootstraps a COMPLETE schema via the CLI", () => {
    // Regression: cmdKnowledge created knowledge_events but not
    // knowledge_edges, so a CLI-created teammate accepted synced events and
    // silently discarded every edge — leaving them holding knowledge they
    // could not resolve by file. bobDb has never existed before this line.
    const res = cli(
      ["knowledge", "sync", "--remote", remote, "--workspace", "acme", "--project", "alice", "--token", bobToken],
      { INVENTARIUM_DB_PATH: bobDb },
    );
    expect(res.code).toBe(0);

    const db = new Database(bobDb, { readonly: true });
    const tables = (db.query(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as Array<{ name: string }>).map((t) => t.name);
    db.close();

    for (const required of ["knowledge_events", "knowledge_edges", "sync_state"]) {
      expect(tables).toContain(required);
    }
  }, 60_000);

  test("6. THE PAYOFF — Bob resolves Alice's failure by file, on his own machine", async () => {
    const db = new Database(bobDb, { readonly: true });
    const events = db.query("SELECT subject, actor_name FROM knowledge_events").all() as Array<{ subject: string; actor_name: string }>;
    const edges = db.query("SELECT dst, kind FROM knowledge_edges").all() as Array<{ dst: string; kind: string }>;
    db.close();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.subject).toContain("harden the login auth flow");

    // Not merely PRESENT — RESOLVABLE. This is the whole thesis: Bob's next
    // task touching src/auth.ts inherits Alice's failure without a git push,
    // and it only works if the edge survived the wire with a matching id.
    expect(edges.map((e) => e.dst)).toContain("file:src/auth.ts");

    const { knowledgeGoverning } = await import("../../core/src/knowledge/edges.ts");
    const live = new Database(bobDb);
    const governing = knowledgeGoverning(live, ["src/auth.ts"]);
    live.close();
    expect(governing.length).toBeGreaterThan(0);
    expect(governing[0]!.event.subject).toContain("harden the login auth flow");
  }, 60_000);

  test("7. a second sync is a no-op — the loop converges", () => {
    const before = (() => {
      const db = new Database(bobDb, { readonly: true });
      const n = (db.query("SELECT COUNT(*) AS n FROM knowledge_events").get() as { n: number }).n;
      const e = (db.query("SELECT COUNT(*) AS n FROM knowledge_edges").get() as { n: number }).n;
      db.close();
      return { n, e };
    })();

    cli(["knowledge", "sync", "--remote", remote, "--workspace", "acme", "--project", "alice", "--token", bobToken], { INVENTARIUM_DB_PATH: bobDb });

    const db = new Database(bobDb, { readonly: true });
    const after = {
      n: (db.query("SELECT COUNT(*) AS n FROM knowledge_events").get() as { n: number }).n,
      e: (db.query("SELECT COUNT(*) AS n FROM knowledge_edges").get() as { n: number }).n,
    };
    db.close();
    // Grow-only must mean converging, not accumulating.
    expect(after).toEqual(before);
  }, 60_000);

  test("8. the graph API serves what the explorer renders", async () => {
    const res = await fetch(`http://localhost:${alicePort}/api/knowledge/graph`);
    expect(res.status).toBe(200);
    const g = await res.json() as { nodes: Array<{ kind: string; label: string }>; edges: unknown[] };
    expect(g.nodes.some((n) => n.kind === "event")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "file" && n.label === "auth.ts")).toBe(true);
    expect(g.edges.length).toBeGreaterThan(0);
  }, 30_000);
});
