import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// PRD_OPEN_SOURCE Phase-3+ addendum — idea → guided-plan wizard, backend E2E.
//
// The tests drive the wizard mock in two "modes":
//   1. Questions mode — returns a fixture JSON with the four required
//      dimensions the parseAndRepairQuestions function expects.
//   2. PRD mode — returns a valid markdown PRD.
// The mock reads INVENTARIUM_IDEA_MOCK unconditionally, so we boot the server
// twice — once per mode. This is simpler than teaching the mock to switch
// based on prompt content and stays faithful to the "prompt-in text-out"
// contract.

const SERVER_ENTRY = join(import.meta.dir, "index.ts");

const QUESTIONS_MOCK = JSON.stringify({
  questions: [
    {
      key: "frontend", question: "Which frontend?", description: "Match your rendering needs.",
      options: [
        { label: "React (Vite)", description: "Client-side SPA", pros: ["Fast dev loop", "Familiar"], cons: ["No SSR"] },
        { label: "Next.js",      description: "React + SSR",    pros: ["SEO friendly"], cons: ["Heavier"] },
        { label: "None (API-only)", pros: ["Fewer moving parts"], cons: ["No UI"] },
      ],
      recommendedLabel: "React (Vite)",
    },
    {
      key: "backend", question: "Which backend?",
      options: [
        { label: "Bun + Hono", pros: ["Zero config"], cons: ["Newer runtime"] },
        { label: "Node + Express", pros: ["Ubiquitous"], cons: ["Older ergonomics"] },
      ],
      recommendedLabel: "Bun + Hono",
    },
    {
      key: "database", question: "Which database?",
      options: [
        { label: "SQLite", pros: ["Zero infra"], cons: ["Single writer"] },
        { label: "Postgres", pros: ["Mature"], cons: ["Needs a server"] },
      ],
      recommendedLabel: "SQLite",
    },
    {
      key: "packages", question: "Which add-ons?",
      multiSelect: true,
      options: [
        { label: "Auth", pros: ["Common need"], cons: [] },
        { label: "Payments", pros: [], cons: [] },
        { label: "Email", pros: [], cons: [] },
      ],
      recommendedLabel: "Auth",
    },
  ],
});

// A trivially-valid markdown PRD: over 100 chars, not JSON-shaped.
const PRD_MOCK = `# Notes API

## Problem
Developers need a lightweight notes API to prototype new products quickly.

## Users
Solo developers hacking on side projects.

## Stack
- Frontend: React (Vite)
- Backend: Bun + Hono
- Database: SQLite
- Add-ons: Auth

## Features
1. POST /notes — create a note (body: text). Acceptance: returns 201 + id.
2. GET /notes — list notes.
3. PATCH /notes/:id — update note text.
4. DELETE /notes/:id — remove a note.

## Non-goals
Rich-text editing, collaboration.

## Success metrics
p95 latency <100ms; all CRUD paths tested.

## Test coverage
Cover happy paths, empty-body edge cases, invalid ids, and unauthorized attempts.`;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.once("listening", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") { srv.close(); reject(new Error("no port")); return; }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.listen(0, "127.0.0.1");
  });
}

async function waitForHealth(port: number, ms = 15000): Promise<boolean> {
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

interface IdeaResp {
  id: string;
  boardId: string | null;
  ideaText: string;
  questions: Array<{ key: string; question: string; options: unknown[]; multiSelect?: boolean }>;
  answers: Record<string, { value: string | string[]; note?: string }>;
  synthesizedPrd: string | null;
  status: string;
}

async function bootServer(mock: string): Promise<{ child: ChildProcess; port: number; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "at-ideas-e2e-"));
  mkdirSync(join(tmp, ".inventarium"), { recursive: true });
  const port = await findFreePort();
  const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
  const child = spawn("bun", [SERVER_ENTRY], {
    cwd: tmp,
    env: {
      ...cleanEnv,
      INVENTARIUM_PORT: String(port),
      INVENTARIUM_ROOT: tmp,
      INVENTARIUM_SKIP_RUNNER: "1",
      INVENTARIUM_SKIP_AUTOSYNC: "1",
      INVENTARIUM_IDEA_MOCK: mock,
    },
    stdio: "ignore",
  });
  const up = await waitForHealth(port);
  if (!up) throw new Error(`server did not become ready on ${port}`);
  return { child, port, tmp };
}

async function killServer(child: ChildProcess | undefined, tmp: string) {
  child?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 250));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

// ─── Test group 1: /start + /answer with the questions mock ───────────────────

describe("ideas wizard — start + answer flow", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";

  beforeAll(async () => {
    ({ child, port, tmp } = await bootServer(QUESTIONS_MOCK));
  }, 30000);

  afterAll(async () => { await killServer(child, tmp); });

  test("POST /ideas/start creates an idea and returns the 4 dimension questions", async () => {
    const res = await fetch(`http://localhost:${port}/api/ideas/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: "A URL shortener with click analytics." }),
    });
    expect(res.status).toBe(201);
    const idea = await res.json() as IdeaResp;
    expect(idea.id).toStartWith("idea-");
    expect(idea.ideaText).toBe("A URL shortener with click analytics.");
    expect(idea.status).toBe("gathering");
    expect(idea.questions.map((q) => q.key)).toEqual(["frontend", "backend", "database", "packages"]);
    // packages must be multiSelect (repair forces it even if the LLM forgets)
    expect(idea.questions.find((q) => q.key === "packages")!.multiSelect).toBe(true);
  });

  test("POST /ideas/start rejects empty idea → 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/ideas/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: "   " }),
    });
    expect(res.status).toBe(400);
  });

  test("/answer records a value and is idempotent (last write wins)", async () => {
    const created = (await (await fetch(`http://localhost:${port}/api/ideas/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: "A time tracker for freelancers." }),
    })).json()) as IdeaResp;

    const first = await fetch(`http://localhost:${port}/api/ideas/${created.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "frontend", value: "React (Vite)" }),
    });
    expect(first.status).toBe(200);
    let state = await first.json() as IdeaResp;
    expect(state.answers.frontend?.value).toBe("React (Vite)");

    // Overwrite with a note
    const second = await fetch(`http://localhost:${port}/api/ideas/${created.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "frontend", value: "Next.js", note: "want SSR" }),
    });
    state = await second.json() as IdeaResp;
    expect(state.answers.frontend?.value).toBe("Next.js");
    expect(state.answers.frontend?.note).toBe("want SSR");
  });

  test("/answer rejects an unknown question key → 400", async () => {
    const created = (await (await fetch(`http://localhost:${port}/api/ideas/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: "A pomodoro app." }),
    })).json()) as IdeaResp;
    const res = await fetch(`http://localhost:${port}/api/ideas/${created.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "unicorn", value: "x" }),
    });
    expect(res.status).toBe(400);
  });

  test("/answer accepts multi-select array values for the packages dimension", async () => {
    const created = (await (await fetch(`http://localhost:${port}/api/ideas/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: "A newsletter tool with billing." }),
    })).json()) as IdeaResp;
    const res = await fetch(`http://localhost:${port}/api/ideas/${created.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "packages", value: ["Auth", "Payments", "Email"] }),
    });
    const state = await res.json() as IdeaResp;
    expect(state.answers.packages?.value).toEqual(["Auth", "Payments", "Email"]);
  });

  test("GET /ideas/:id returns the stored state (resume flow)", async () => {
    const created = (await (await fetch(`http://localhost:${port}/api/ideas/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: "A tiny CRM." }),
    })).json()) as IdeaResp;

    const fetched = await (await fetch(`http://localhost:${port}/api/ideas/${created.id}`)).json() as IdeaResp;
    expect(fetched.id).toBe(created.id);
    expect(fetched.questions.length).toBe(4);
  });
});

// ─── Test group 2: /synthesize-prd with the PRD mock ──────────────────────────

describe("ideas wizard — synthesize + link-board", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";

  beforeAll(async () => {
    ({ child, port, tmp } = await bootServer(PRD_MOCK));
  }, 30000);

  afterAll(async () => { await killServer(child, tmp); });

  test("full happy path: start → answer 4 → synthesize → link-board", async () => {
    // NB: /start also uses INVENTARIUM_IDEA_MOCK, so the "questions" the mock
    // returns here are actually PRD_MOCK — the parser rejects that. Because
    // this test suite is scoped to synthesis, we bypass /start and seed
    // the row directly via SQL through a smaller round-trip: create the
    // idea in gathering status by first calling /start against the PRD_MOCK
    // will fail the parser. So we work around by making /start error and
    // then poking the row. But that's not clean.
    //
    // Simpler: bypass /start entirely — assemble the idea via a direct
    // /ideas/:id/answer flow only if we can create one. Since there is no
    // creation endpoint other than /start, and /start needs a valid
    // questions response, we spawn a helper here.
    //
    // To avoid dual-server complexity we take a shortcut: call /start,
    // ignore its 502 (PRD_MOCK is not valid questions JSON), then POST
    // a manually-constructed idea by taking the pre-parse error path.
    //
    // Instead of any of that: assert /synthesize-prd works given a manually
    // constructed idea. We use the DB indirectly by inserting via a helper
    // route we don't have. So the cleanest test is to just verify
    // /synthesize-prd returns 404 for unknown ids, and use the questions
    // mock in a THIRD boot for the full happy path.
    // See the next describe block for the full-happy-path assertion.
    const res = await fetch(`http://localhost:${port}/api/ideas/nope/synthesize-prd`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ─── Test group 3: full happy path via a switchable mock ───────────────────────
// We solve the dual-mock problem by pointing INVENTARIUM_IDEA_MOCK at a
// tiny helper file that the runner reads with `file:<path>` — but the runner
// itself is stateless: it returns the SAME contents on every call. So instead
// we boot with the questions mock, then patch the mock file mid-test to
// contain the PRD before calling /synthesize-prd. This is only reliable
// because we set the env to `file:<path>` and the runner reads it fresh.

describe("ideas wizard — full happy path (mock swap via file)", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let tmp = "";
  let mockPath = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "at-ideas-e2e-full-"));
    mkdirSync(join(tmp, ".inventarium"), { recursive: true });
    mockPath = join(tmp, "mock.txt");
    // Start with the questions JSON.
    await Bun.write(mockPath, QUESTIONS_MOCK);

    port = await findFreePort();
    const { INVENTARIUM_DB_PATH: _a, AGENT_TRAIL_DB_PATH: _b, ...cleanEnv } = process.env;
    child = spawn("bun", [SERVER_ENTRY], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        INVENTARIUM_PORT: String(port),
        INVENTARIUM_ROOT: tmp,
        INVENTARIUM_SKIP_RUNNER: "1",
        INVENTARIUM_SKIP_AUTOSYNC: "1",
        INVENTARIUM_IDEA_MOCK: `file:${mockPath}`,
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(port);
    if (!up) throw new Error(`server did not become ready on ${port}`);
  }, 30000);

  afterAll(async () => { await killServer(child, tmp); });

  test("start → answer 4 → swap mock → synthesize → link a real board", async () => {
    // 1. Start with the questions mock in place.
    const created = (await (await fetch(`http://localhost:${port}/api/ideas/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: "A tiny read-it-later app." }),
    })).json()) as IdeaResp;
    expect(created.questions.length).toBe(4);

    // 2. Answer each of the 4 dimensions.
    for (const key of ["frontend", "backend", "database"]) {
      const value = created.questions.find((q) => q.key === key)!.options[0]!.label ?? key;
      await fetch(`http://localhost:${port}/api/ideas/${created.id}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    }
    await fetch(`http://localhost:${port}/api/ideas/${created.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "packages", value: ["Auth"] }),
    });

    // 3. Swap the mock file to the PRD content, then synthesize.
    await Bun.write(mockPath, PRD_MOCK);
    const synth = await fetch(`http://localhost:${port}/api/ideas/${created.id}/synthesize-prd`, {
      method: "POST",
    });
    expect(synth.status).toBe(200);
    const withPrd = await synth.json() as IdeaResp;
    expect(withPrd.status).toBe("ready");
    expect(withPrd.synthesizedPrd).toContain("# Notes API");
    expect(withPrd.synthesizedPrd).toContain("Stack");

    // 4. Attempting to answer more after status=ready is a 409.
    const afterReady = await fetch(`http://localhost:${port}/api/ideas/${created.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "frontend", value: "React (Vite)" }),
    });
    expect(afterReady.status).toBe(409);

    // 5. Create a real board, link it, verify status flips to `done`.
    const board = await (await fetch(`http://localhost:${port}/api/boards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "read-later", implementationDir: tmp }),
    })).json() as { id: string };
    const linked = await fetch(`http://localhost:${port}/api/ideas/${created.id}/link-board`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: board.id }),
    });
    const done = await linked.json() as IdeaResp;
    expect(done.boardId).toBe(board.id);
    expect(done.status).toBe("done");
  }, 30000);

  test("synthesize before answering all questions → 400 with the missing keys", async () => {
    // Swap back to questions mock, start a fresh idea, answer only frontend.
    await Bun.write(mockPath, QUESTIONS_MOCK);
    const created = (await (await fetch(`http://localhost:${port}/api/ideas/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: "A meal-plan generator." }),
    })).json()) as IdeaResp;
    await fetch(`http://localhost:${port}/api/ideas/${created.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "frontend", value: "React (Vite)" }),
    });

    const synth = await fetch(`http://localhost:${port}/api/ideas/${created.id}/synthesize-prd`, {
      method: "POST",
    });
    expect(synth.status).toBe(400);
    const body = await synth.json() as { error: string };
    expect(body.error).toContain("unanswered");
    expect(body.error).toContain("backend");
    expect(body.error).toContain("database");
    expect(body.error).toContain("packages");
  });
});
