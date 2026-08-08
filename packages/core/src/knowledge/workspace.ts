// knowledgelayer §5.1 — workspaces, membership, and real relay identity.
//
// Replaces the shared bearer token, which was never identity: anyone holding
// it could read or write ANY workspace on that relay, and every event arrived
// anonymous at the transport layer.
//
// Three properties this file exists to guarantee:
//
//   1. **Tokens are never stored.** Only sha256(secret) is persisted. A stolen
//      database yields no usable credential. The plaintext is returned exactly
//      once, at creation.
//   2. **Workspace scope is server-derived, never client-asserted.** The
//      caller's token determines which workspace it may touch. A `workspaceId`
//      in a request body is untrusted input, not authorization.
//   3. **Roles gate writes.** A viewer can read a team's knowledge without
//      being able to inject rulings into it.

import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ulid } from "./ulid.ts";

export const WORKSPACE_DDL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT
);

CREATE TABLE IF NOT EXISTS workspace_users (
  id           TEXT PRIMARY KEY,
  -- Stable external identity. For GitHub OAuth this is 'github:<numeric id>',
  -- never the login: logins are renameable and would silently re-point a
  -- membership at a different human.
  external_id  TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email        TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  -- Public half of the credential; safe to log and index on.
  id           TEXT PRIMARY KEY,
  -- sha256 of the secret half. The secret itself is never persisted.
  secret_hash  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  label        TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT,
  revoked_at   TEXT,
  last_used_at TEXT
);
`;

export const WORKSPACE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_tokens_workspace ON api_tokens(workspace_id)",
];

/** Ordered least → most privileged. Comparison is by index, so adding a tier
 *  in the middle automatically tightens everything above it. */
export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = typeof ROLES[number];

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

export interface WorkspaceUser {
  id: string;
  externalId: string;
  displayName: string;
  email: string | null;
}

export interface AuthContext {
  user: WorkspaceUser;
  workspaceId: string;
  role: Role;
  tokenId: string;
}

export type AuthFailure =
  | "no_token" | "malformed_token" | "unknown_token"
  | "revoked" | "expired" | "no_membership" | "insufficient_role";

export type AuthResult =
  | { ok: true; ctx: AuthContext }
  | { ok: false; reason: AuthFailure };

export function ensureWorkspaceSchema(db: Database): void {
  db.exec(WORKSPACE_DDL);
  for (const sql of WORKSPACE_INDEXES) db.exec(sql);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time hex compare. Length mismatch is already a mismatch, and
 *  timingSafeEqual throws on unequal lengths, so it is checked first. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// ── Users & workspaces ───────────────────────────────────────────────────────

export function createWorkspace(db: Database, opts: { id?: string; name: string; createdBy?: string }): string {
  ensureWorkspaceSchema(db);
  const id = opts.id ?? ulid();
  db.query("INSERT OR IGNORE INTO workspaces (id, name, created_at, created_by) VALUES (?,?,?,?)")
    .run(id, opts.name, new Date().toISOString(), opts.createdBy ?? null);
  return id;
}

export function upsertUser(
  db: Database,
  opts: { externalId: string; displayName: string; email?: string | null },
): WorkspaceUser {
  ensureWorkspaceSchema(db);
  const existing = db.query("SELECT * FROM workspace_users WHERE external_id = ?")
    .get(opts.externalId) as Record<string, string | null> | null;
  if (existing) {
    db.query("UPDATE workspace_users SET display_name = ?, email = ? WHERE id = ?")
      .run(opts.displayName, opts.email ?? existing.email ?? null, existing.id as string);
    return {
      id: existing.id as string,
      externalId: opts.externalId,
      displayName: opts.displayName,
      email: (opts.email ?? existing.email) as string | null,
    };
  }
  const id = ulid();
  db.query("INSERT INTO workspace_users (id, external_id, display_name, email, created_at) VALUES (?,?,?,?,?)")
    .run(id, opts.externalId, opts.displayName, opts.email ?? null, new Date().toISOString());
  return { id, externalId: opts.externalId, displayName: opts.displayName, email: opts.email ?? null };
}

export function addMember(db: Database, workspaceId: string, userId: string, role: Role): void {
  ensureWorkspaceSchema(db);
  db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES (?,?,?,?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
  ).run(workspaceId, userId, role, new Date().toISOString());
}

export function removeMember(db: Database, workspaceId: string, userId: string): void {
  ensureWorkspaceSchema(db);
  db.query("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
  // Tokens outlive nothing: losing membership must lose access immediately,
  // not at the next token expiry.
  db.query("UPDATE api_tokens SET revoked_at = ? WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), workspaceId, userId);
}

export function getRole(db: Database, workspaceId: string, userId: string): Role | null {
  try {
    const row = db.query("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .get(workspaceId, userId) as { role: string } | null;
    return row ? (row.role as Role) : null;
  } catch {
    return null;
  }
}

export function listMembers(db: Database, workspaceId: string): Array<WorkspaceUser & { role: Role }> {
  ensureWorkspaceSchema(db);
  const rows = db.query(
    `SELECT u.id, u.external_id, u.display_name, u.email, m.role
       FROM workspace_members m JOIN workspace_users u ON u.id = m.user_id
      WHERE m.workspace_id = ? ORDER BY m.added_at`,
  ).all(workspaceId) as Array<Record<string, string>>;
  return rows.map((r) => ({
    id: r.id!, externalId: r.external_id!, displayName: r.display_name!,
    email: r.email ?? null, role: r.role as Role,
  }));
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export interface IssuedToken {
  /** Full credential. Returned ONCE — it is not recoverable afterwards. */
  token: string;
  id: string;
  expiresAt: string | null;
}

const TOKEN_PREFIX = "at";

/**
 * Issue a token scoped to exactly one workspace.
 *
 * Format `at_<id>_<secret>`. The id is a lookup key so verification is one
 * indexed read rather than a scan over every token comparing hashes — a scan
 * would make verification cost grow with team size and leak timing.
 */
export function createToken(
  db: Database,
  opts: { userId: string; workspaceId: string; label?: string; ttlDays?: number },
): IssuedToken {
  ensureWorkspaceSchema(db);
  const id = ulid();
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = opts.ttlDays
    ? new Date(Date.now() + opts.ttlDays * 86_400_000).toISOString()
    : null;

  db.query(
    `INSERT INTO api_tokens (id, secret_hash, user_id, workspace_id, label, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, sha256(secret), opts.userId, opts.workspaceId, opts.label ?? null, new Date().toISOString(), expiresAt);

  return { token: `${TOKEN_PREFIX}_${id}_${secret}`, id, expiresAt };
}

export function revokeToken(db: Database, tokenId: string): boolean {
  ensureWorkspaceSchema(db);
  const res = db.query("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), tokenId);
  return (res as { changes?: number }).changes !== 0;
}

export function listTokens(db: Database, workspaceId: string): Array<{
  id: string; userId: string; label: string | null;
  createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null;
}> {
  ensureWorkspaceSchema(db);
  const rows = db.query("SELECT * FROM api_tokens WHERE workspace_id = ? ORDER BY created_at DESC")
    .all(workspaceId) as Array<Record<string, string | null>>;
  return rows.map((r) => ({
    id: r.id as string, userId: r.user_id as string, label: r.label,
    createdAt: r.created_at as string, expiresAt: r.expires_at,
    revokedAt: r.revoked_at, lastUsedAt: r.last_used_at,
  }));
}

/**
 * Split on the FIRST TWO underscores only; everything after is the secret.
 *
 * A naive `split("_")` was a real defect: the secret is base64url, whose
 * alphabet INCLUDES `_`, so any token whose random half happened to contain one
 * produced 4+ parts and was rejected as malformed. Roughly half of all issued
 * credentials would have failed to authenticate, intermittently, with a
 * "malformed token" error pointing at the client rather than at this function.
 */
function parseToken(raw: string): { id: string; secret: string } | null {
  const s = raw.trim();
  const first = s.indexOf("_");
  if (first < 0 || s.slice(0, first) !== TOKEN_PREFIX) return null;
  const second = s.indexOf("_", first + 1);
  if (second < 0) return null;
  const id = s.slice(first + 1, second);
  const secret = s.slice(second + 1);
  if (!id || !secret) return null;
  return { id, secret };
}

/**
 * Verify a credential and resolve the workspace it is scoped to.
 *
 * The caller does NOT get to say which workspace it wants — the token decides.
 * That inversion is the fix for the shared-secret model, where a request body
 * could name any workspace and be believed.
 */
export function authenticate(db: Database, rawToken: string | null | undefined): AuthResult {
  if (!rawToken) return { ok: false, reason: "no_token" };
  const parsed = parseToken(rawToken);
  if (!parsed) return { ok: false, reason: "malformed_token" };

  let row: Record<string, string | null> | null = null;
  try {
    row = db.query("SELECT * FROM api_tokens WHERE id = ?").get(parsed.id) as Record<string, string | null> | null;
  } catch {
    return { ok: false, reason: "unknown_token" };
  }
  if (!row) return { ok: false, reason: "unknown_token" };
  if (!hashesMatch(row.secret_hash as string, sha256(parsed.secret))) {
    // Same failure as an unknown id, so a valid id with a wrong secret is not
    // distinguishable from a guess.
    return { ok: false, reason: "unknown_token" };
  }
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: "expired" };

  const userRow = db.query("SELECT * FROM workspace_users WHERE id = ?")
    .get(row.user_id as string) as Record<string, string | null> | null;
  if (!userRow) return { ok: false, reason: "unknown_token" };

  const workspaceId = row.workspace_id as string;
  const role = getRole(db, workspaceId, row.user_id as string);
  // Membership is re-checked on every request, so removing someone takes
  // effect immediately rather than whenever their token happens to expire.
  if (!role) return { ok: false, reason: "no_membership" };

  try {
    db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), parsed.id);
  } catch { /* last_used is telemetry, not authorization */ }

  return {
    ok: true,
    ctx: {
      user: {
        id: userRow.id as string,
        externalId: userRow.external_id as string,
        displayName: userRow.display_name as string,
        email: userRow.email,
      },
      workspaceId,
      role,
      tokenId: parsed.id,
    },
  };
}

/** Authenticate and require a minimum role. */
export function authorize(db: Database, rawToken: string | null | undefined, required: Role): AuthResult {
  const res = authenticate(db, rawToken);
  if (!res.ok) return res;
  if (!roleAtLeast(res.ctx.role, required)) return { ok: false, reason: "insufficient_role" };
  return res;
}

/** HTTP status for a failure. `no_membership` is 403 rather than 404 because
 *  the credential IS valid — hiding that would only confuse the operator. */
export function statusForFailure(reason: AuthFailure): 401 | 403 {
  return reason === "insufficient_role" || reason === "no_membership" ? 403 : 401;
}

/** Extract a bearer token from an Authorization header. */
export function bearerFrom(header: string | undefined | null): string | null {
  if (!header) return null;
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}
