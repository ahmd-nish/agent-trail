import { describe, expect, test } from "bun:test";
import { extractContract, renderContract, stripFunctionBody } from "./contracts.ts";

describe("extractContract() — TypeScript exports", () => {
  test("returns null when files provide nothing extractable", () => {
    expect(extractContract({ files: [] })).toBeNull();
    const result = extractContract({
      files: [{ path: "notes.md", content: "just some prose" }],
    });
    expect(result).toBeNull();
  });

  test("function signatures", () => {
    const c = extractContract({
      files: [{
        path: "packages/core/src/auth/session.ts",
        content: `
export function createSession(userId: string, ttlMs?: number): Promise<Session> {
  // impl
  return null as any;
}

export async function verifySession(token: string): Promise<Session | null> {
  return null;
}
`,
      }],
    });
    expect(c).not.toBeNull();
    expect(c?.provides.exports).toContain(
      "function createSession(userId: string, ttlMs?: number): Promise<Session>",
    );
    expect(c?.provides.exports.some((e) => e.includes("verifySession"))).toBe(true);
    expect(c?.entrypoints).toContain("packages/core/src/auth/session.ts:createSession");
    expect(c?.entrypoints).toContain("packages/core/src/auth/session.ts:verifySession");
    expect(c?.provides.modules).toEqual(["packages/core/src/auth/session.ts"]);
  });

  test("arrow-const, class, interface, type, enum shapes", () => {
    const c = extractContract({
      files: [{
        path: "misc.ts",
        content: `
export const greet = (name: string): string => \`Hello, \${name}!\`;
export const CONFIG = { retries: 3 };
export const TIMEOUT_MS: number = 500;
export class Server {}
export interface Session { id: string; userId: string; }
export type UserId = string;
export enum Status { ready, running, done }
`,
      }],
    });
    const exp = c!.provides.exports.join("\n");
    expect(exp).toMatch(/const greet = \(name: string\): string =>/);
    expect(exp).toMatch(/const CONFIG/);
    expect(exp).toMatch(/const TIMEOUT_MS: number/);
    expect(exp).toContain("class Server");
    expect(exp).toContain("interface Session");
    expect(exp).toContain("type UserId = string");
    expect(exp).toContain("enum Status");
  });

  test("routes extracted from Hono / Express / Fastify style handlers", () => {
    const c = extractContract({
      files: [{
        path: "server.ts",
        content: `
import { Hono } from "hono";
const app = new Hono();
app.get("/api/health", () => "ok");
app.post("/api/sessions", createHandler);
router.delete("/api/sessions/:id", del);
api.patch('/api/users/:id', update);
`,
      }],
    });
    expect(c!.provides.routes).toEqual([
      "DELETE /api/sessions/:id",
      "GET /api/health",
      "PATCH /api/users/:id",
      "POST /api/sessions",
    ]);
  });

  test("tables extracted from CREATE TABLE statements", () => {
    const c = extractContract({
      files: [{
        path: "migration.sql",
        content: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  session_id TEXT,
  token_hash TEXT
);
`,
      }],
    });
    expect(c!.provides.tables.sort()).toEqual(["refresh_tokens", "sessions"]);
  });

  test("env vars extracted from process.env reads", () => {
    const c = extractContract({
      files: [{
        path: "config.ts",
        content: `
const port = process.env["PORT"] ?? "3002";
const secret = process.env.SESSION_SECRET;
const ttl = process.env['SESSION_TTL_MS'];
// noise — lowercase should not match
const home = process.env.home;
`,
      }],
    });
    expect(c!.provides.env.sort()).toEqual(["PORT", "SESSION_SECRET", "SESSION_TTL_MS"]);
  });

  test("events extracted from emit() and webhook payloads", () => {
    const c = extractContract({
      files: [{
        path: "events.ts",
        content: `
export function created() {
  emit("session.created", data);
  sendWebhook({ event: "user.registered", payload });
}
`,
      }],
    });
    expect(c!.provides.events.sort()).toEqual(["session.created", "user.registered"]);
  });

  test("comments do not confuse the export detector", () => {
    const c = extractContract({
      files: [{
        path: "x.ts",
        content: `
// export function fake(): void {}  ← this is a comment, not real
/* export function alsoFake(): void {} */
export function real(): void {}
`,
      }],
    });
    const names = c!.provides.exports.join(" ");
    expect(names).toContain("real");
    expect(names).not.toContain("fake");
    expect(names).not.toContain("alsoFake");
  });

  test("multiline function signature is captured on one line", () => {
    const c = extractContract({
      files: [{
        path: "wide.ts",
        content: `
export function build(
  opts: {
    root: string;
    verbose?: boolean;
    timeout?: number;
  },
): Promise<Result> {
  return null as any;
}
`,
      }],
    });
    const sig = c!.provides.exports[0]!;
    expect(sig).toContain("function build");
    expect(sig).toContain("root: string");
    expect(sig).toContain("Promise<Result>");
    // Whitespace collapsed to single spaces
    expect(sig).not.toMatch(/\n/);
  });

  test("baseSha and taskId preserved in output", () => {
    const c = extractContract({
      taskId: "t-42",
      baseSha: "a1b2c3d",
      files: [{ path: "x.ts", content: "export const X = 1;" }],
    });
    expect(c!.taskId).toBe("t-42");
    expect(c!.baseSha).toBe("a1b2c3d");
  });
});

describe("renderContract() — prompt-friendly output", () => {
  test("empty-ish contract renders cleanly", () => {
    const c = extractContract({ files: [{ path: "x.ts", content: "export const X = 1;" }] })!;
    const out = renderContract(c);
    expect(out).toContain("modules: x.ts");
    expect(out).toContain("const X");
  });

  test("full contract has section headers for each provides slot", () => {
    const c = extractContract({
      files: [
        { path: "session.ts", content: `
export function createSession(u: string): Session { return null as any; }
app.get("/api/session", handler);
process.env["SESSION_SECRET"];
emit("session.created", d);
` },
        { path: "migration.sql", content: `CREATE TABLE sessions (id TEXT);` },
      ],
    })!;
    const out = renderContract(c);
    expect(out).toContain("exports:");
    expect(out).toContain("routes: GET /api/session");
    expect(out).toContain("tables:");
    expect(out).toContain("sessions");
    expect(out).toContain("env: SESSION_SECRET");
    expect(out).toContain("events: session.created");
    expect(out).toContain("entrypoints:");
  });
});

describe("stripFunctionBody", () => {
  test("cuts a one-line body but keeps the full signature", () => {
    expect(stripFunctionBody("function f(a: string): string { return a; }"))
      .toBe("function f(a: string): string");
  });

  test("keeps an object return type", () => {
    // `: {` opens a type, not a body — cutting here would truncate the
    // signature, which is the whole thing a contract exists to convey.
    expect(stripFunctionBody("function f(a: string): { id: string; n: number }"))
      .toBe("function f(a: string): { id: string; n: number }");
  });

  test("cuts the body after an object return type", () => {
    expect(stripFunctionBody("function f(a: string): { id: string } { return { id: a }; }"))
      .toBe("function f(a: string): { id: string }");
  });

  test("handles a default value containing braces in the params", () => {
    expect(stripFunctionBody("function f(o = { a: 1 }): void { go(); }"))
      .toBe("function f(o = { a: 1 }): void");
  });

  test("leaves a body-less signature untouched", () => {
    expect(stripFunctionBody("function f(a: string): Promise<void>"))
      .toBe("function f(a: string): Promise<void>");
  });
});
