import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  KNOWLEDGE_EDGES_DDL, KNOWLEDGE_EDGES_INDEXES,
  KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES,
} from "../../core/src/knowledge/schema.ts";
import { append, list } from "../../core/src/knowledge/store.ts";
import { knowledgeGoverning } from "../../core/src/knowledge/edges.ts";
import { getSyncState, syncOnce } from "../../core/src/knowledge/sync.ts";
import type { NewKnowledgeEvent } from "../../core/src/knowledge/types.ts";

// knowledgelayer §4.6 — two machines, one workspace.
//
// Exit criterion: answer a decision on machine A; machine B inherits it with
// NO git push. Machine A and B are separate SQLite files that never touch each
// other's disk — the only thing between them is the relay's HTTP surface.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");
const TOKEN = "test-relay-token-abc123";

function freeport(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.once("listening", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") { srv.close(); reject(new Error("no port")); return; }
      const p = addr.port; srv.close(() => resolve(p));
    });
    srv.listen(0, "127.0.0.1");
  });
}

async function waitForHealth(port: number, ms = 20000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return true;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function machine(): Database {
  const db = new Database(":memory:");
  db.exec(KNOWLEDGE_EVENTS_DDL);
  for (const s of KNOWLEDGE_EVENTS_INDEXES) db.exec(s);
  db.exec(KNOWLEDGE_EDGES_DDL);
  for (const s of KNOWLEDGE_EDGES_INDEXES) db.exec(s);
  return db;
}

function ev(o: Partial<NewKnowledgeEvent> = {}): NewKnowledgeEvent {
  return {
    workspaceId: "acme", projectId: "app",
    actorKind: "human", actorId: "sarah@acme.com", actorName: "Sarah",
    taskId: null, executionId: null,
    type: "decision", scope: "project",
    subject: "sessions must be sha256-hashed", body: "raw tokens are never persisted",
    paths: ["src/auth/session.ts"], confidence: "ruling", supersedes: null,
    ...o,
  };
}

describe("relay — two machines, one workspace (§4.6)", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let remote = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-relay-"));
    port = await freeport();
    const { AGENT_TRAIL_DB_PATH: _a, VIBE_BOARD_DB_PATH: _b, ...clean } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...clean,
        AGENT_TRAIL_PORT: String(port),
        AGENT_TRAIL_ROOT: tmp,
        AGENT_TRAIL_SKIP_RUNNER: "1",
        AGENT_TRAIL_SKIP_AUTOSYNC: "1",
        AGENT_TRAIL_SKIP_HYDRATE: "1",
        AGENT_TRAIL_RELAY_TOKEN: TOKEN,
      },
      stdio: "ignore",
    });
    if (!await waitForHealth(port)) throw new Error(`relay did not start on ${port}`);
    remote = `http://localhost:${port}`;
  }, 40000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const opts = { remote: "", workspaceId: "acme", projectId: "app", token: TOKEN };

  test("EXIT CRITERION — a ruling made on A reaches B with no git push", async () => {
    const A = machine();
    const B = machine();
    append(A, ev());

    const pushed = await syncOnce(A, { ...opts, remote });
    expect(pushed.skipped).toBe(false);
    expect(pushed.pushed.events).toBe(1);

    const pulled = await syncOnce(B, { ...opts, remote });
    expect(pulled.pulled.events).toBe(1);

    const onB = list(B, {});
    expect(onB.length).toBe(1);
    expect(onB[0]!.subject).toBe("sessions must be sha256-hashed");
    // Attribution survives the wire — this is a fact FROM SARAH on B's machine,
    // not an anonymous row.
    expect(onB[0]!.actorName).toBe("Sarah");

    // And it is not merely present, it is USABLE: B's governance query finds it
    // by file, which requires the edge to have replicated with a matching id.
    const governing = knowledgeGoverning(B, ["src/auth/session.ts"]);
    expect(governing.length).toBe(1);
    expect(governing[0]!.event.subject).toBe("sessions must be sha256-hashed");

    A.close(); B.close();
  }, 30000);

  test("identity is preserved across the wire, so edges still resolve", async () => {
    const A = machine();
    const B = machine();
    const { event } = append(A, ev({ subject: "identity check ruling" }));
    await syncOnce(A, { ...opts, remote });
    await syncOnce(B, { ...opts, remote });
    const mirrored = list(B, {}).find((e) => e.subject === "identity check ruling");
    // Same ULID on both machines — `governs` edges point at kev:<ulid>, so a
    // re-keyed event would silently orphan every edge that referenced it.
    expect(mirrored?.id).toBe(event.id);
    A.close(); B.close();
  }, 30000);

  test("sync is idempotent — a second round trip moves nothing", async () => {
    const A = machine();
    append(A, ev({ subject: "idempotence probe" }));
    await syncOnce(A, { ...opts, remote });
    const second = await syncOnce(A, { ...opts, remote });
    expect(second.pushed.events).toBe(0);
    // Pulling back its own event must not duplicate it.
    expect(list(A, {}).filter((e) => e.subject === "idempotence probe").length).toBe(1);
    A.close();
  }, 30000);

  test("supersession replicates, so B sees the correction and not the original", async () => {
    const A = machine();
    const B = machine();
    const first = append(A, ev({ subject: "use callbacks", paths: ["src/x.ts"] })).event;
    append(A, ev({ subject: "use promises", paths: ["src/x.ts"], supersedes: first.id }));
    await syncOnce(A, { ...opts, remote });
    await syncOnce(B, { ...opts, remote });

    const active = list(B, { activeOnly: true }).map((e) => e.subject);
    expect(active).toContain("use promises");
    expect(active).not.toContain("use callbacks");
    A.close(); B.close();
  }, 30000);

  test("offline is not an error — cursors hold and the next sync sends everything", async () => {
    const A = machine();
    append(A, ev({ subject: "written while offline" }));
    const failed = await syncOnce(A, {
      ...opts, remote: "http://127.0.0.1:9",   // nothing listening
    });
    expect(failed.skipped).toBe(true);
    expect(failed.reason).toBeTruthy();

    // The cursor did NOT advance, so the retry sends the same event.
    const ok = await syncOnce(A, { ...opts, remote });
    expect(ok.pushed.events).toBeGreaterThanOrEqual(1);
    A.close();
  }, 30000);

  test("sync:local-only sends nothing and reads nothing", async () => {
    const A = machine();
    append(A, ev({ subject: "confidential local ruling" }));
    const res = await syncOnce(A, { ...opts, remote, localOnly: true });
    expect(res.skipped).toBe(true);
    expect(res.reason).toContain("local-only");
    expect(res.pushed.events).toBe(0);
    // Checked before any read of the log, so nothing can leak past a later bug.
    expect(getSyncState(A, remote)).toBeNull();
    A.close();
  }, 30000);

  test("a bad token is rejected", async () => {
    const res = await fetch(`${remote}/v1/events?workspace=acme&project=app`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  test("no token is rejected", async () => {
    const res = await fetch(`${remote}/v1/events?workspace=acme&project=app`);
    expect(res.status).toBe(401);
  });

  test("a project's events do not leak into another project's pull", async () => {
    const A = machine();
    append(A, ev({ subject: "project-one secret", projectId: "one" }));
    await syncOnce(A, { ...opts, remote, projectId: "one" });

    const B = machine();
    await syncOnce(B, { ...opts, remote, projectId: "two" });
    expect(list(B, {}).map((e) => e.subject)).not.toContain("project-one secret");
    A.close(); B.close();
  }, 30000);

  test("malformed rows are skipped without stalling the batch", async () => {
    const res = await fetch(`${remote}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        workspaceId: "acme", projectId: "app",
        events: [
          { nonsense: true },                       // rejected
          { ...ev({ subject: "valid alongside junk" }), id: "01JCVALIDULIDVALID000001" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { inserted: { events: number }; rejected: number };
    // One bad row from a newer client must not stall a teammate's whole sync.
    expect(body.rejected).toBe(1);
    expect(body.inserted.events).toBe(1);
  });
});
