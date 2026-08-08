import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  addMember, authenticate, authorize, createToken, createWorkspace, ensureWorkspaceSchema,
  getRole, listMembers, listTokens, removeMember, revokeToken, roleAtLeast, statusForFailure,
  upsertUser, bearerFrom,
} from "./workspace.ts";

function db2(): Database {
  const db = new Database(":memory:");
  ensureWorkspaceSchema(db);
  return db;
}

function seed(db: Database, role: "viewer" | "member" | "admin" | "owner" = "member") {
  const ws = createWorkspace(db, { id: "acme", name: "Acme" });
  const user = upsertUser(db, { externalId: "github:1", displayName: "Sarah", email: "s@acme.com" });
  addMember(db, ws, user.id, role);
  const token = createToken(db, { userId: user.id, workspaceId: ws, label: "laptop" });
  return { ws, user, token };
}

describe("token storage", () => {
  test("the secret is never persisted — only its hash", () => {
    const db = db2();
    const { token } = seed(db);
    const secret = token.token.split("_")[2]!;
    const dump = JSON.stringify(db.query("SELECT * FROM api_tokens").all());
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(token.token);
    // A stolen database must yield no usable credential.
    expect(dump).toContain("secret_hash");
  });

  test("a valid token authenticates and resolves its workspace and role", () => {
    const db = db2();
    const { token, user } = seed(db, "admin");
    const res = authenticate(db, token.token);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ctx.workspaceId).toBe("acme");
    expect(res.ctx.role).toBe("admin");
    expect(res.ctx.user.id).toBe(user.id);
    expect(res.ctx.user.displayName).toBe("Sarah");
  });

  test("a valid id with the wrong secret is indistinguishable from an unknown token", () => {
    const db = db2();
    const { token } = seed(db);
    const [prefix, id] = token.token.split("_");
    const forged = `${prefix}_${id}_notTheRealSecret`;
    expect(authenticate(db, forged)).toEqual({ ok: false, reason: "unknown_token" });
    expect(authenticate(db, "at_01NONEXISTENT_secret")).toEqual({ ok: false, reason: "unknown_token" });
  });

  test("every issued token authenticates — base64url secrets contain underscores", () => {
    // Regression: parseToken split on EVERY underscore, but the secret half is
    // base64url whose alphabet includes `_`. Roughly half of all real tokens
    // were rejected as malformed. One token is not enough to catch it.
    const db = db2();
    const ws = createWorkspace(db, { id: "acme", name: "Acme" });
    const user = upsertUser(db, { externalId: "github:1", displayName: "Sarah" });
    addMember(db, ws, user.id, "member");

    let withUnderscore = 0;
    for (let i = 0; i < 50; i++) {
      const t = createToken(db, { userId: user.id, workspaceId: ws });
      if (t.token.split("_").length > 3) withUnderscore++;
      const res = authenticate(db, t.token);
      expect(res.ok).toBe(true);
    }
    // Sanity-check the test itself actually exercises the case.
    expect(withUnderscore).toBeGreaterThan(0);
  });

  test("malformed credentials are rejected without touching the database", () => {
    const db = db2();
    for (const bad of ["", "garbage", "Bearer x", "at_only-two", "at__", "xx_a_b"]) {
      const res = authenticate(db, bad);
      expect(res.ok).toBe(false);
    }
  });

  test("revoked tokens stop working", () => {
    const db = db2();
    const { token } = seed(db);
    expect(authenticate(db, token.token).ok).toBe(true);
    expect(revokeToken(db, token.id)).toBe(true);
    expect(authenticate(db, token.token)).toEqual({ ok: false, reason: "revoked" });
    expect(revokeToken(db, token.id)).toBe(false);   // already revoked
  });

  test("expired tokens stop working", () => {
    const db = db2();
    const ws = createWorkspace(db, { id: "acme", name: "Acme" });
    const user = upsertUser(db, { externalId: "github:9", displayName: "Old" });
    addMember(db, ws, user.id, "member");
    const token = createToken(db, { userId: user.id, workspaceId: ws, ttlDays: -1 });
    expect(authenticate(db, token.token)).toEqual({ ok: false, reason: "expired" });
  });

  test("listTokens never exposes the secret or its hash", () => {
    const db = db2();
    seed(db);
    const listed = listTokens(db, "acme");
    expect(listed.length).toBe(1);
    expect(JSON.stringify(listed)).not.toContain("secret");
  });
});

describe("workspace scoping — the hole the shared secret left", () => {
  test("a token cannot reach a workspace it was not issued for", () => {
    const db = db2();
    const { token } = seed(db);
    createWorkspace(db, { id: "other", name: "Other" });
    const res = authenticate(db, token.token);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The credential DECIDES the workspace. There is no argument by which a
    // caller can ask for a different one.
    expect(res.ctx.workspaceId).toBe("acme");
    expect(res.ctx.workspaceId).not.toBe("other");
  });

  test("membership is re-checked per request, so removal takes effect immediately", () => {
    const db = db2();
    const { token, user, ws } = seed(db);
    expect(authenticate(db, token.token).ok).toBe(true);
    removeMember(db, ws, user.id);
    // Not "at next expiry" — now.
    const after = authenticate(db, token.token);
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(["no_membership", "revoked"]).toContain(after.reason);
  });

  test("removing a member also revokes their tokens for that workspace", () => {
    const db = db2();
    const { user, ws } = seed(db);
    removeMember(db, ws, user.id);
    expect(listTokens(db, ws).every((t) => t.revokedAt !== null)).toBe(true);
  });

  test("a token for a user who was never a member is refused", () => {
    const db = db2();
    const ws = createWorkspace(db, { id: "acme", name: "Acme" });
    const user = upsertUser(db, { externalId: "github:2", displayName: "Stranger" });
    const token = createToken(db, { userId: user.id, workspaceId: ws });
    expect(authenticate(db, token.token)).toEqual({ ok: false, reason: "no_membership" });
  });
});

describe("roles", () => {
  test("ordering is least to most privileged", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("member", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "member")).toBe(false);
    expect(roleAtLeast("member", "admin")).toBe(false);
  });

  test("a viewer may read but not write", () => {
    const db = db2();
    const { token } = seed(db, "viewer");
    expect(authorize(db, token.token, "viewer").ok).toBe(true);
    const write = authorize(db, token.token, "member");
    expect(write.ok).toBe(false);
    if (write.ok) return;
    expect(write.reason).toBe("insufficient_role");
  });

  test("a member may write but not administer members", () => {
    const db = db2();
    const { token } = seed(db, "member");
    expect(authorize(db, token.token, "member").ok).toBe(true);
    expect(authorize(db, token.token, "admin").ok).toBe(false);
  });

  test("insufficient role is 403, bad credential is 401", () => {
    // A valid credential that lacks permission is a different problem from an
    // invalid one, and an operator debugging it needs to see which.
    expect(statusForFailure("insufficient_role")).toBe(403);
    expect(statusForFailure("no_membership")).toBe(403);
    expect(statusForFailure("unknown_token")).toBe(401);
    expect(statusForFailure("expired")).toBe(401);
  });
});

describe("users and members", () => {
  test("identity keys on a stable external id, not a renameable login", () => {
    const db = db2();
    const first = upsertUser(db, { externalId: "github:42", displayName: "old-login" });
    const renamed = upsertUser(db, { externalId: "github:42", displayName: "new-login" });
    // Same human, renamed on GitHub — must not become a second user.
    expect(renamed.id).toBe(first.id);
    expect(renamed.displayName).toBe("new-login");
  });

  test("re-adding a member updates their role rather than duplicating them", () => {
    const db = db2();
    const { ws, user } = seed(db, "member");
    addMember(db, ws, user.id, "admin");
    expect(getRole(db, ws, user.id)).toBe("admin");
    expect(listMembers(db, ws).length).toBe(1);
  });

  test("bearerFrom parses only well-formed headers", () => {
    expect(bearerFrom("Bearer abc")).toBe("abc");
    expect(bearerFrom("bearer abc")).toBeNull();   // case-sensitive scheme
    expect(bearerFrom("abc")).toBeNull();
    expect(bearerFrom("Bearer ")).toBeNull();
    expect(bearerFrom(undefined)).toBeNull();
  });
});
