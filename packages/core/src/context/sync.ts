import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

// PRD_OPEN_SOURCE §3.1 — `.agent-trail/` as source of truth.
// The board + task graph serialize to a single merge-friendly JSON file at
// `.agent-trail/state.json`. Teammates who clone the repo and run
// `npx agent-trail` hydrate the exact same board out of SQLite, no setup.

const CONTEXT_DIRNAME = ".agent-trail";
const STATE_FILENAME = "state.json";
const STATE_SCHEMA_VERSION = 1;

export function statePath(root: string): string {
  return join(root, CONTEXT_DIRNAME, STATE_FILENAME);
}

// ─── Serialized shape ────────────────────────────────────────────────────────
//
// Field names mirror the SQLite column names so a git diff reads like a schema
// dump — no camelCase mapping to reason about while resolving conflicts.

export interface SerializedBoard {
  id: string;
  name: string;
  prd_source: string | null;
  webhook_url: string | null;
  default_model: string | null;
  default_assignee: string;
  default_review_kind: string;
  permission_mode: string;
  implementation_dir: string | null;
  dev_command: string | null;
  dev_port: number | null;
  execution_timeout_ms: number;
  execution_cost_cap_usd: number;
  execution_token_cap: number;
  auto_commit: number;
  auto_pr: number;
  commit_style: string;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SerializedTask {
  id: string;
  board_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string;
  tdd_enabled: number;
  tdd_phase: string;
  mcps: string;
  skills: string;
  subagents: string;
  depends_on: string;
  parallel_group: number | null;
  active_form: string | null;
  worktree_path: string | null;
  last_error: string | null;
  success_criteria: string;
  guardrails: string;
  epic: string | null;
  sprint: string | null;
  review_kind: string;
  reviewer: string | null;
  additional_prompt: string | null;
  model: string | null;
  model_tier: string | null;
  component: string | null;
  external_dependencies: string;
  test_cases: string;
  failed_verify_count: number;
  loop_policy: string | null;
  likely_paths: string;
  created_at: string;
  updated_at: string;
}

export interface StateFile {
  version: number;
  exported_at: string;
  boards: SerializedBoard[];
  tasks: SerializedTask[];
}

// ─── Serialize (DB → JSON) ───────────────────────────────────────────────────

const BOARD_COLUMNS = [
  "id","name","prd_source","webhook_url","default_model","default_assignee",
  "default_review_kind","permission_mode","implementation_dir","dev_command","dev_port",
  "execution_timeout_ms","execution_cost_cap_usd","execution_token_cap",
  "auto_commit","auto_pr","commit_style","approved_at","created_at","updated_at",
] as const;

const TASK_COLUMNS = [
  "id","board_id","title","description","status","priority","assignee",
  "tdd_enabled","tdd_phase","mcps","skills","subagents","depends_on",
  "parallel_group","active_form","worktree_path","last_error","success_criteria",
  "guardrails","epic","sprint","review_kind","reviewer","additional_prompt",
  "model","model_tier","component","external_dependencies","test_cases",
  "failed_verify_count","loop_policy","likely_paths",
  "created_at","updated_at",
] as const;

export function serializeState(db: Database): StateFile {
  const boards = db.query(`SELECT ${BOARD_COLUMNS.join(",")} FROM boards ORDER BY id`).all() as SerializedBoard[];
  const tasks = db.query(`SELECT ${TASK_COLUMNS.join(",")} FROM tasks ORDER BY board_id, id`).all() as SerializedTask[];
  // Normalize numeric flags — SQLite may return null/undefined for missing rows;
  // we want stable 0/1 in the serialized form for review-friendly diffs.
  for (const b of boards) {
    b.auto_commit = Number(b.auto_commit ?? 0);
    b.auto_pr = Number(b.auto_pr ?? 0);
    b.execution_cost_cap_usd = Number(b.execution_cost_cap_usd ?? 0);
    b.execution_token_cap = Number(b.execution_token_cap ?? 0);
    b.execution_timeout_ms = Number(b.execution_timeout_ms ?? 1_200_000);
  }
  for (const t of tasks) {
    t.tdd_enabled = Number(t.tdd_enabled ?? 0);
    t.failed_verify_count = Number(t.failed_verify_count ?? 0);
  }
  return {
    version: STATE_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    boards,
    tasks,
  };
}

// ─── Deserialize (JSON → DB) ─────────────────────────────────────────────────

export interface HydrateResult {
  boardsUpserted: number;
  tasksUpserted: number;
  skippedVersion: boolean;
}

export function deserializeAndUpsert(db: Database, state: StateFile): HydrateResult {
  if (state.version !== STATE_SCHEMA_VERSION) {
    return { boardsUpserted: 0, tasksUpserted: 0, skippedVersion: true };
  }

  const upsertBoard = db.query(
    `INSERT INTO boards (${BOARD_COLUMNS.join(",")}) VALUES (${BOARD_COLUMNS.map(() => "?").join(",")})
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       prd_source = excluded.prd_source,
       webhook_url = excluded.webhook_url,
       default_model = excluded.default_model,
       default_assignee = excluded.default_assignee,
       default_review_kind = excluded.default_review_kind,
       permission_mode = excluded.permission_mode,
       implementation_dir = excluded.implementation_dir,
       dev_command = excluded.dev_command,
       dev_port = excluded.dev_port,
       execution_timeout_ms = excluded.execution_timeout_ms,
       execution_cost_cap_usd = excluded.execution_cost_cap_usd,
       execution_token_cap = excluded.execution_token_cap,
       auto_commit = excluded.auto_commit,
       auto_pr = excluded.auto_pr,
       commit_style = excluded.commit_style,
       approved_at = excluded.approved_at,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= boards.updated_at`,
  );

  const upsertTask = db.query(
    `INSERT INTO tasks (${TASK_COLUMNS.join(",")}) VALUES (${TASK_COLUMNS.map(() => "?").join(",")})
     ON CONFLICT(id) DO UPDATE SET
       board_id = excluded.board_id,
       title = excluded.title,
       description = excluded.description,
       status = excluded.status,
       priority = excluded.priority,
       assignee = excluded.assignee,
       tdd_enabled = excluded.tdd_enabled,
       tdd_phase = excluded.tdd_phase,
       mcps = excluded.mcps,
       skills = excluded.skills,
       subagents = excluded.subagents,
       depends_on = excluded.depends_on,
       parallel_group = excluded.parallel_group,
       active_form = excluded.active_form,
       worktree_path = excluded.worktree_path,
       last_error = excluded.last_error,
       success_criteria = excluded.success_criteria,
       guardrails = excluded.guardrails,
       epic = excluded.epic,
       sprint = excluded.sprint,
       review_kind = excluded.review_kind,
       reviewer = excluded.reviewer,
       additional_prompt = excluded.additional_prompt,
       model = excluded.model,
       model_tier = excluded.model_tier,
       component = excluded.component,
       external_dependencies = excluded.external_dependencies,
       test_cases = excluded.test_cases,
       failed_verify_count = excluded.failed_verify_count,
       loop_policy = excluded.loop_policy,
       likely_paths = excluded.likely_paths,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= tasks.updated_at`,
  );

  let boardsUpserted = 0;
  for (const b of state.boards) {
    upsertBoard.run(...BOARD_COLUMNS.map((c) => valueOrDefault(b, c, BOARD_DEFAULTS)));
    boardsUpserted++;
  }
  let tasksUpserted = 0;
  for (const t of state.tasks) {
    upsertTask.run(...TASK_COLUMNS.map((c) => valueOrDefault(t, c, TASK_DEFAULTS)));
    tasksUpserted++;
  }
  return { boardsUpserted, tasksUpserted, skippedVersion: false };
}

// Column defaults used when hydrating a state.json produced by an older
// agent-trail (missing columns added after export). Keeps hydration
// forward-compatible without a schema version bump per column addition.
const BOARD_DEFAULTS: Record<string, unknown> = {
  default_assignee: "claude-code",
  default_review_kind: "none",
  permission_mode: "acceptEdits",
  execution_timeout_ms: 1_200_000,
  execution_cost_cap_usd: 0,
  execution_token_cap: 0,
  auto_commit: 0,
  auto_pr: 0,
  commit_style: "conventional",
};

const TASK_DEFAULTS: Record<string, unknown> = {
  description: "",
  priority: "medium",
  assignee: "claude-code",
  tdd_enabled: 0,
  tdd_phase: "implement_only",
  mcps: "[]",
  skills: "[]",
  subagents: "[]",
  depends_on: "[]",
  success_criteria: "[]",
  guardrails: "[]",
  review_kind: "none",
  external_dependencies: "[]",
  test_cases: "[]",
  failed_verify_count: 0,
  likely_paths: "[]",
};

function valueOrDefault(obj: unknown, col: string, defaults: Record<string, unknown>): unknown {
  const value = (obj as Record<string, unknown>)[col];
  if (value !== undefined && value !== null) return value;
  if (col in defaults) return defaults[col];
  return null;
}

// ─── File IO ─────────────────────────────────────────────────────────────────

export function readStateFile(root: string): StateFile | null {
  const path = statePath(root);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as StateFile;
  } catch {
    return null;
  }
}

/** Atomic write via tmp + rename so a mid-write kill can't corrupt state.json. */
export function writeStateFile(root: string, state: StateFile): string {
  const path = statePath(root);
  const dir = join(root, CONTEXT_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  return path;
}

// ─── Round-trip helpers wired by the server ──────────────────────────────────

export function exportToFile(db: Database, root: string): string {
  return writeStateFile(root, serializeState(db));
}

export function hydrateFromFile(db: Database, root: string): HydrateResult | null {
  const state = readStateFile(root);
  if (!state) return null;
  return deserializeAndUpsert(db, state);
}

// ─── Auto-sync (debounced + dirty-checked) ───────────────────────────────────
//
// The server calls `startAutoSync(db, root)` once at boot. Every 2s we
// serialize the current state and compare its hash to the last-written hash;
// only re-write when it changed. Zero work in the common idle case; picks up
// every mutation without route instrumentation.

interface AutoSyncHandle {
  stop(): void;
  /** Flush pending state immediately (used in tests + graceful shutdown). */
  flush(): void;
}

export function startAutoSync(db: Database, root: string, intervalMs = 2000): AutoSyncHandle {
  let lastHash = "";
  // Initial baseline hash — if state.json already exists on disk, hash its
  // current contents so we don't overwrite it with an equivalent copy.
  try {
    const existing = readStateFile(root);
    if (existing) lastHash = hashState({ ...existing, exported_at: "" });
  } catch { /* fall through to next tick */ }

  const tick = () => {
    try {
      const state = serializeState(db);
      const hash = hashState({ ...state, exported_at: "" });
      if (hash !== lastHash) {
        writeStateFile(root, state);
        lastHash = hash;
      }
    } catch (err) {
      // Never let sync crash the server — log and continue.
      console.warn(`[state-sync] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handle = setInterval(tick, intervalMs);
  // Don't keep the event loop alive just for state sync — process exit is fine.
  if (typeof (handle as ReturnType<typeof setInterval> & { unref?: () => void }).unref === "function") {
    (handle as ReturnType<typeof setInterval> & { unref: () => void }).unref();
  }
  return {
    stop: () => clearInterval(handle),
    flush: tick,
  };
}

function hashState(state: StateFile): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
