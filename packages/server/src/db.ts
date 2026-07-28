import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board, Task, TaskStatus, Priority, AgentKind, TddPhase, ReviewKind, Guardrail, PermissionMode, TestCase } from "../../core/src/types/index.ts";
import { DEFAULT_PERMISSION_MODE, DEFAULT_EXECUTION_TIMEOUT_MS } from "../../core/src/types/index.ts";
import { resolveDbPath, resolveProjectRoot } from "../../core/src/storage/paths.ts";
import { KNOWLEDGE_EVENTS_DDL, KNOWLEDGE_EVENTS_INDEXES } from "../../core/src/knowledge/schema.ts";

const schemaPath = join(import.meta.dir, "../../core/src/storage/schema.sql");

// ─── Migrations ──────────────────────────────────────────────────────────────
//
// `schema.sql` is the v0.1.1 baseline — it always reflects the *current* shape
// of the database and runs once on a fresh install. After v0.1.1 ships, every
// schema change appends a new migration to this array (never edit or remove).
//
// For users still on pre-v0.1.1 DBs (which had a series of in-place ALTERs
// recorded as versions 1-4 in their `schema_version` table), the v0.1.1
// baseline migration below uses idempotent column checks so applying it again
// is a safe no-op. Their `schema_version` row count may stay at 4 — that's
// fine, applyMigrations only runs entries strictly greater than current.

const MIGRATIONS: ReadonlyArray<{ version: number; description: string; up: (db: Database) => void }> = [
  {
    version: 1,
    description: "v0.1.1 baseline schema (see schema.sql)",
    up: (db) => {
      // Idempotent additive columns — covers DBs that pre-date schema.sql v0.1.1
      // and never ran the historical migrations. Fresh installs already have
      // every column from schema.sql, so each check is a no-op.
      const altersIfMissing: Array<[string, string, string]> = [
        ["boards", "webhook_url",         "TEXT"],
        ["boards", "default_model",       "TEXT"],
        ["boards", "default_assignee",    "TEXT NOT NULL DEFAULT 'claude-code'"],
        ["boards", "default_review_kind", "TEXT NOT NULL DEFAULT 'none'"],
        ["boards", "permission_mode",     "TEXT NOT NULL DEFAULT 'acceptEdits' CHECK(permission_mode IN ('default','acceptEdits','bypassPermissions','plan'))"],
        ["tasks",  "success_criteria",    "TEXT NOT NULL DEFAULT '[]'"],
        ["tasks",  "guardrails",          "TEXT NOT NULL DEFAULT '[]'"],
        ["tasks",  "epic",                "TEXT"],
        ["tasks",  "sprint",              "TEXT"],
        ["tasks",  "review_kind",         "TEXT NOT NULL DEFAULT 'none'"],
        ["tasks",  "reviewer",            "TEXT"],
        ["tasks",  "additional_prompt",   "TEXT"],
        ["tasks",  "model",               "TEXT"],
        ["tasks",  "component",           "TEXT"],
        ["tasks",  "external_dependencies","TEXT NOT NULL DEFAULT '[]'"],
        ["tasks",  "last_error",          "TEXT"],
      ];
      for (const [table, col, def] of altersIfMissing) {
        if (!columnExists(db, table, col)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        }
      }
    },
  },
  {
    version: 2,
    description: "board.implementation_dir — Claude's output directory",
    up: (db) => {
      if (!columnExists(db, "boards", "implementation_dir")) {
        db.exec("ALTER TABLE boards ADD COLUMN implementation_dir TEXT");
      }
    },
  },
  {
    version: 3,
    description: "task.test_cases — persisted test case dashboard per task",
    up: (db) => {
      if (!columnExists(db, "tasks", "test_cases")) {
        db.exec("ALTER TABLE tasks ADD COLUMN test_cases TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    version: 4,
    description: "board.dev_command + board.dev_port — managed dev server config",
    up: (db) => {
      if (!columnExists(db, "boards", "dev_command")) {
        db.exec("ALTER TABLE boards ADD COLUMN dev_command TEXT");
      }
      if (!columnExists(db, "boards", "dev_port")) {
        db.exec("ALTER TABLE boards ADD COLUMN dev_port INTEGER");
      }
    },
  },
  {
    version: 5,
    description: "Backfill boards.permission_mode for any legacy NULL rows",
    up: (db) => {
      // Schema and migration v1 both define this column NOT NULL DEFAULT
      // 'acceptEdits', but pre-v0.1.1 databases may still hold NULLs from
      // earlier in-place ALTERs. Align them with the runtime default so the
      // ?? fallbacks in rowToBoard / execution-manager become dead code.
      db.exec("UPDATE boards SET permission_mode = 'acceptEdits' WHERE permission_mode IS NULL");
    },
  },
  {
    version: 6,
    description: "Rename vibe-board.db → agent-trail.db (handled at file level in paths.ts)",
    up: () => {
      // No-op: the actual rename happens in resolveDbPath() before the DB is
      // opened. Recorded here so the schema_version row exists for any tooling
      // that expects a contiguous sequence.
    },
  },
  {
    version: 7,
    description: "boards.execution_timeout_ms — per-board hard ceiling for claude runs",
    up: (db) => {
      // 1_200_000 ms = 20 minutes. Long enough for non-trivial work, short
      // enough that a hang doesn't waste an afternoon. Adjustable per board.
      if (!columnExists(db, "boards", "execution_timeout_ms")) {
        db.exec("ALTER TABLE boards ADD COLUMN execution_timeout_ms INTEGER NOT NULL DEFAULT 1200000");
      }
    },
  },
  {
    version: 8,
    description: "Multi-tenancy groundwork — workspace_id on every owning table",
    up: (db) => {
      // Phase 2 prep: every row gets a workspace_id. Default 'local' covers
      // the OSS single-user install; the day cloud collab ships, swapping the
      // default is a config change, not a backfill.
      const tables = ["boards", "tasks", "executions", "telemetry_events", "artifacts", "decision_tickets"];
      for (const t of tables) {
        if (!columnExists(db, t, "workspace_id")) {
          db.exec(`ALTER TABLE ${t} ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local'`);
        }
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_boards_workspace ON boards(workspace_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workspace_board ON tasks(workspace_id, board_id)");
    },
  },
  {
    version: 9,
    description: "board_env — encrypted per-board environment variables for test-case substitution",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS board_env (
          id              TEXT    PRIMARY KEY,
          board_id        TEXT    NOT NULL,
          key             TEXT    NOT NULL,
          value_encrypted TEXT    NOT NULL,
          created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE(board_id, key),
          FOREIGN KEY(board_id) REFERENCES boards(id) ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_board_env_board ON board_env(board_id)");
    },
  },
  {
    version: 10,
    description: "test_case_runs — per-case run history for trend sparklines",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS test_case_runs (
          id              TEXT    PRIMARY KEY,
          test_case_id    TEXT    NOT NULL,
          task_id         TEXT    NOT NULL,
          passed          INTEGER NOT NULL,
          duration_ms     INTEGER NOT NULL,
          attempts        INTEGER NOT NULL DEFAULT 1,
          output          TEXT,
          assertions_json TEXT,
          ran_at          TEXT    NOT NULL,
          created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_test_case_runs_case ON test_case_runs(test_case_id, ran_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_test_case_runs_task ON test_case_runs(task_id)");
    },
  },
  {
    version: 11,
    description: "tasks.model_tier — static model-router tier (haiku/sonnet/opus)",
    up: (db) => {
      if (!columnExists(db, "tasks", "model_tier")) {
        db.exec("ALTER TABLE tasks ADD COLUMN model_tier TEXT CHECK(model_tier IN ('haiku','sonnet','opus'))");
      }
    },
  },
  {
    version: 12,
    description: "test_case_runs.outcome — flaky_pass/pass/fail/error (PRD_TESTING T1.6)",
    up: (db) => {
      if (!columnExists(db, "test_case_runs", "outcome")) {
        db.exec("ALTER TABLE test_case_runs ADD COLUMN outcome TEXT");
      }
      if (!columnExists(db, "test_case_runs", "redaction_applied")) {
        db.exec("ALTER TABLE test_case_runs ADD COLUMN redaction_applied INTEGER");
      }
      if (!columnExists(db, "test_case_runs", "server_recorded")) {
        // 1 = written by the Test Execution Service (evidence-grade); 0 = legacy
        // client-report path (existing UI). Gate consumers filter on this.
        db.exec("ALTER TABLE test_case_runs ADD COLUMN server_recorded INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    version: 13,
    description: "case_examples — round-trip learning for T3.4 (agent-first case gen)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS case_examples (
          id                TEXT PRIMARY KEY,
          board_id          TEXT NOT NULL,
          original_json     TEXT NOT NULL,
          fixed_json        TEXT NOT NULL,
          note              TEXT,
          created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY(board_id) REFERENCES boards(id) ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_case_examples_board ON case_examples(board_id, created_at DESC)");
    },
  },
  {
    version: 14,
    description: "Phase-2: executions.claude_session_id + boards.cost/token budgets + auto-pr/commit prefs",
    up: (db) => {
      // 2.2 resume — record the claude CLI session_id so `--resume` can hand
      // it back on restart. Populated from the final `result` event.
      if (!columnExists(db, "executions", "claude_session_id")) {
        db.exec("ALTER TABLE executions ADD COLUMN claude_session_id TEXT");
      }
      // 2.3 budgets — per-board caps applied to every task's cumulative usage
      // during a single run. `execution_cost_cap_usd` = 0 disables the cap.
      if (!columnExists(db, "boards", "execution_cost_cap_usd")) {
        db.exec("ALTER TABLE boards ADD COLUMN execution_cost_cap_usd REAL NOT NULL DEFAULT 0");
      }
      if (!columnExists(db, "boards", "execution_token_cap")) {
        db.exec("ALTER TABLE boards ADD COLUMN execution_token_cap INTEGER NOT NULL DEFAULT 0");
      }
      // 2.5/2.6 opt-in per board.
      if (!columnExists(db, "boards", "auto_commit")) {
        db.exec("ALTER TABLE boards ADD COLUMN auto_commit INTEGER NOT NULL DEFAULT 0");
      }
      if (!columnExists(db, "boards", "auto_pr")) {
        db.exec("ALTER TABLE boards ADD COLUMN auto_pr INTEGER NOT NULL DEFAULT 0");
      }
      if (!columnExists(db, "boards", "commit_style")) {
        db.exec("ALTER TABLE boards ADD COLUMN commit_style TEXT NOT NULL DEFAULT 'conventional'");
      }
    },
  },
  {
    version: 15,
    description: "Phase-4: tasks.failed_verify_count — router-v2 escalation on repeated verify_tests failures",
    up: (db) => {
      // §4.5 model router v2 — auto-escalate the tier once a task has failed
      // verify_tests twice in a row. Counter resets to 0 on successful verify
      // or on tier escalation itself.
      if (!columnExists(db, "tasks", "failed_verify_count")) {
        db.exec("ALTER TABLE tasks ADD COLUMN failed_verify_count INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    version: 16,
    description: "Idea wizard — ideas table for the guided idea→PRD flow",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ideas (
          id TEXT PRIMARY KEY,
          board_id TEXT,
          idea_text TEXT NOT NULL,
          questions TEXT NOT NULL DEFAULT '[]',
          answers TEXT NOT NULL DEFAULT '{}',
          synthesized_prd TEXT,
          status TEXT NOT NULL DEFAULT 'gathering',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE SET NULL
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status, created_at DESC)");
    },
  },
  {
    version: 17,
    description: "Plan-review gate — boards.approved_at (nullable = pending human approval)",
    up: (db) => {
      // §C plan-approval gate. Manually-created boards get an approved_at
      // set to created_at (existing behaviour — user knows what they're doing).
      // Planner-created boards leave it null so execution is blocked until the
      // user reviews the plan and hits "Approve & Start Building".
      if (!columnExists(db, "boards", "approved_at")) {
        db.exec("ALTER TABLE boards ADD COLUMN approved_at TEXT");
        // Backfill existing boards — they've been running fine without a gate,
        // and we don't want the upgrade to freeze them.
        db.query("UPDATE boards SET approved_at = COALESCE(approved_at, created_at)").run();
      }
    },
  },
  {
    version: 18,
    description: "§5.1 loop policy — tasks.loop_policy (nullable JSON = use tddEnabled defaults)",
    up: (db) => {
      if (!columnExists(db, "tasks", "loop_policy")) {
        db.exec("ALTER TABLE tasks ADD COLUMN loop_policy TEXT");
      }
    },
  },
  {
    version: 19,
    description: "§4.4b steering queue — pending steers merged into L1 at next spawn",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS steering (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'note',
          text TEXT NOT NULL,
          consumed_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_steering_pending ON steering(task_id, consumed_at, created_at)");
    },
  },
  {
    version: 20,
    description: "§4.7 file-footprint parallelism — tasks.likely_paths JSON array",
    up: (db) => {
      if (!columnExists(db, "tasks", "likely_paths")) {
        db.exec("ALTER TABLE tasks ADD COLUMN likely_paths TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    version: 21,
    description: "§5.2 Ralph iteration memory — per-iteration compact retry summaries",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS iteration_memories (
          id           TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL,
          iteration    INTEGER NOT NULL,
          summary      TEXT NOT NULL,
          test_output_tail TEXT,
          git_diff_head    TEXT,
          created_at   TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_iteration_memories_task ON iteration_memories(task_id, iteration DESC)");
    },
  },
  {
    version: 22,
    description: "§5.6 deploy agent — deploy_targets + deploys tables (human-gated executions)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS deploy_targets (
          id             TEXT PRIMARY KEY,
          board_id       TEXT NOT NULL,
          name           TEXT NOT NULL,
          kind           TEXT NOT NULL DEFAULT 'shell',
          command        TEXT NOT NULL,
          healthcheck_url TEXT,
          rollback_command TEXT,
          working_dir    TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          UNIQUE (board_id, name),
          FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS deploys (
          id               TEXT PRIMARY KEY,
          board_id         TEXT NOT NULL,
          target_id        TEXT NOT NULL,
          decision_ticket_id TEXT,
          status           TEXT NOT NULL DEFAULT 'pending',
          command_output   TEXT,
          healthcheck_status TEXT,
          rollback_output  TEXT,
          started_at       TEXT NOT NULL,
          finished_at      TEXT,
          FOREIGN KEY (board_id)  REFERENCES boards(id)          ON DELETE CASCADE,
          FOREIGN KEY (target_id) REFERENCES deploy_targets(id)  ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_deploys_board ON deploys(board_id, started_at DESC)");
    },
  },
  {
    version: 23,
    description: "knowledgelayer §4.1 — knowledge_events (typed, append-only log)",
    up: (db) => {
      // The substrate every other primitive in the shared knowledge layer
      // is a deterministic fold of. Owned by @agent-trail/core; DDL lives
      // in packages/core/src/knowledge/schema.ts so the migration and the
      // in-memory tests share one source of truth.
      db.exec(KNOWLEDGE_EVENTS_DDL);
      for (const sql of KNOWLEDGE_EVENTS_INDEXES) db.exec(sql);
    },
  },
];

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

function applyMigrations(db: Database): void {
  // schema_version is in schema.sql for fresh installs, but pre-v0.1.1 DBs
  // need it created here too. IF NOT EXISTS makes both cases work.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  const current =
    (db.query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version").get() as { v: number } | null)?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    try {
      db.exec("BEGIN");
      m.up(db);
      db.query("INSERT INTO schema_version (version, description) VALUES (?, ?)").run(m.version, m.description);
      db.exec("COMMIT");
      console.log(`[db] migration v${m.version} applied — ${m.description}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration v${m.version} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── DB singleton ────────────────────────────────────────────────────────────

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database(resolveDbPath(resolveProjectRoot()));
  // PRD_TESTING T0.6: SQLite defaults `foreign_keys = OFF` per connection.
  // The `test_case_runs → tasks ON DELETE CASCADE` (migration v10) declared
  // in migrations only fires when foreign keys are enabled on this handle.
  // Setting it here also protects the `board_env → boards ON DELETE CASCADE`
  // (migration v9), which had the same silent no-op bug.
  _db.exec("PRAGMA foreign_keys = ON");

  // schema.sql is the v0 baseline — only execute it when the DB has no tables
  // yet. After that, every change goes through the migrations array below.
  // This avoids the confusing situation where schema.sql and migration v1 both
  // try to define overlapping columns on every startup.
  const tableCount = (
    _db
      .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get() as { n: number } | null
  )?.n ?? 0;

  if (tableCount === 0) {
    const schema = readFileSync(schemaPath, "utf-8");
    _db.exec(schema);
  }

  applyMigrations(_db);
  reconcileOrphanedRuns(_db);
  return _db;
}

/**
 * Any execution still flagged `running` (or `pending`) at startup is orphaned —
 * its supervising process is gone. Mark it failed and move the task back to a
 * recoverable state so the user can re-run.
 */
function reconcileOrphanedRuns(db: Database): void {
  const now = new Date().toISOString();
  const msg = "Server restarted while this execution was in flight";

  const orphans = db
    .query("SELECT id, task_id FROM executions WHERE status IN ('running','pending') AND finished_at IS NULL")
    .all() as { id: string; task_id: string }[];

  if (orphans.length === 0) return;

  db.exec("BEGIN");
  try {
    const failExec = db.prepare(
      "UPDATE executions SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?",
    );
    const resetTask = db.prepare(
      "UPDATE tasks SET status = 'blocked', active_form = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'",
    );
    for (const o of orphans) {
      failExec.run(now, msg, o.id);
      resetTask.run(msg, now, o.task_id);
    }
    db.exec("COMMIT");
    console.log(`[db] reconciled ${orphans.length} orphaned execution(s) from previous run`);
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("[db] reconcile failed:", err);
  }
}

// ─── Row mappers ───────────────────────────────────────────────────────────────

type BoardRow = {
  id: string;
  name: string;
  prd_source: string | null;
  webhook_url: string | null;
  default_model: string | null;
  default_assignee: string | null;
  default_review_kind: string | null;
  permission_mode: string | null;
  implementation_dir: string | null;
  dev_command: string | null;
  dev_port: number | null;
  execution_timeout_ms: number | null;
  execution_cost_cap_usd: number | null;
  execution_token_cap: number | null;
  auto_commit: number | null;
  auto_pr: number | null;
  commit_style: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
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
  parallel_group: string | null;
  active_form: string | null;
  worktree_path: string | null;
  last_error: string | null;
  success_criteria: string | null;
  guardrails: string | null;
  epic: string | null;
  sprint: string | null;
  review_kind: string | null;
  reviewer: string | null;
  additional_prompt: string | null;
  model: string | null;
  model_tier: string | null;
  component: string | null;
  external_dependencies: string | null;
  test_cases: string | null;
  loop_policy: string | null;
  likely_paths: string | null;
  failed_verify_count: number | null;
  created_at: string;
  updated_at: string;
};

// Safe JSON parse for optional-JSON columns (loop_policy, etc.). Returns null
// on any parse error so a corrupt row can't crash the row mapper.
function safeJsonParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

export function rowToBoard(row: BoardRow): Board {
  return {
    id: row.id,
    name: row.name,
    prdSource: row.prd_source,
    webhookUrl: row.webhook_url ?? null,
    defaultModel: row.default_model ?? null,
    defaultAssignee: (row.default_assignee ?? "claude-code") as AgentKind,
    defaultReviewKind: (row.default_review_kind ?? "none") as ReviewKind,
    permissionMode: (row.permission_mode ?? DEFAULT_PERMISSION_MODE) as PermissionMode,
    implementationDir: row.implementation_dir ?? null,
    devCommand: row.dev_command ?? null,
    devPort: row.dev_port ?? null,
    executionTimeoutMs: row.execution_timeout_ms ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    executionCostCapUsd: row.execution_cost_cap_usd ?? 0,
    executionTokenCap:   row.execution_token_cap ?? 0,
    autoCommit: Boolean(row.auto_commit ?? 0),
    autoPr:     Boolean(row.auto_pr ?? 0),
    commitStyle: row.commit_style ?? "conventional",
    approvedAt: row.approved_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority as Priority,
    assignee: row.assignee as AgentKind,
    tddEnabled: row.tdd_enabled === 1,
    tddPhase: row.tdd_phase as TddPhase,
    mcps: JSON.parse(row.mcps) as string[],
    skills: JSON.parse(row.skills) as string[],
    subagents: JSON.parse(row.subagents) as string[],
    dependsOn: JSON.parse(row.depends_on) as string[],
    parallelGroup: row.parallel_group,
    activeForm: row.active_form,
    worktreePath: row.worktree_path,
    lastError: row.last_error ?? null,
    successCriteria: JSON.parse(row.success_criteria ?? "[]") as string[],
    guardrails: JSON.parse(row.guardrails ?? "[]") as Guardrail[],
    epic: row.epic ?? null,
    sprint: row.sprint ?? null,
    reviewKind: (row.review_kind ?? "none") as ReviewKind,
    reviewer: row.reviewer ?? null,
    additionalPrompt: row.additional_prompt ?? null,
    model: row.model ?? null,
    modelTier: (row.model_tier as "haiku" | "sonnet" | "opus" | null) ?? null,
    component: row.component ?? null,
    externalDependencies: JSON.parse(row.external_dependencies ?? "[]") as string[],
    testCases: JSON.parse(row.test_cases ?? "[]") as TestCase[],
    loopPolicy: row.loop_policy ? safeJsonParse(row.loop_policy) : null,
    likelyPaths: JSON.parse(row.likely_paths ?? "[]") as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Board env helpers (Phase 3b) ────────────────────────────────────────────
// Values are stored encrypted; the helpers below transparently encrypt on
// write and decrypt on read. Callers always see plaintext (or masked
// previews) and never touch ciphertext.

import { encryptSecret, decryptSecret, maskSecret } from "../../core/src/crypto/secrets.ts";

export interface BoardEnvEntry {
  key: string;
  value: string;          // plaintext (or masked if asMask=true)
  masked: boolean;        // true when `value` is a mask, not the real secret
  updatedAt: string;
}

/** Return all env entries for a board. Pass `reveal=true` to decrypt values;
 *  by default values are returned masked. */
export function listBoardEnv(boardId: string, reveal = false): BoardEnvEntry[] {
  const rows = getDb().query(
    "SELECT key, value_encrypted, updated_at FROM board_env WHERE board_id = ? ORDER BY key",
  ).all(boardId) as { key: string; value_encrypted: string; updated_at: string }[];

  return rows.map((row) => {
    if (reveal) {
      try {
        return { key: row.key, value: decryptSecret(row.value_encrypted), masked: false, updatedAt: row.updated_at };
      } catch (err) {
        // Surface decryption failure rather than silently returning garbage —
        // most likely the master.key file changed or got rotated.
        return { key: row.key, value: `[decrypt failed: ${err instanceof Error ? err.message : String(err)}]`, masked: false, updatedAt: row.updated_at };
      }
    }
    // For masked previews we still need to decrypt so the mask reflects the
    // value length / shape. If decryption fails, show a placeholder.
    try {
      return { key: row.key, value: maskSecret(decryptSecret(row.value_encrypted)), masked: true, updatedAt: row.updated_at };
    } catch {
      return { key: row.key, value: "••••••", masked: true, updatedAt: row.updated_at };
    }
  });
}

/** Decrypted map of {KEY: value} for runtime substitution. Skips entries
 *  that fail to decrypt (logged once per call). */
export function getBoardEnvMap(boardId: string): Record<string, string> {
  const rows = getDb().query(
    "SELECT key, value_encrypted FROM board_env WHERE board_id = ?",
  ).all(boardId) as { key: string; value_encrypted: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    try { out[r.key] = decryptSecret(r.value_encrypted); }
    catch (err) {
      console.warn(`[board_env] could not decrypt ${boardId}/${r.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Upsert a single env entry. Plaintext is encrypted before storage. */
export function setBoardEnv(boardId: string, key: string, plaintext: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const enc = encryptSecret(plaintext);
  db.query(
    `INSERT INTO board_env (id, board_id, key, value_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(board_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`,
  ).run(crypto.randomUUID(), boardId, key, enc, now, now);
}

export function deleteBoardEnv(boardId: string, key: string): boolean {
  const res = getDb().query("DELETE FROM board_env WHERE board_id = ? AND key = ?").run(boardId, key);
  return res.changes > 0;
}

// ─── Test-case run history (Phase 3d) ────────────────────────────────────────

export interface TestCaseRunRow {
  id: string;
  testCaseId: string;
  taskId: string;
  passed: boolean;
  durationMs: number;
  attempts: number;
  output: string | null;
  assertionsJson: string | null;
  ranAt: string;
}

/** Append a new run record. `lastRun` on the TestCase JSON stays as a
 *  denormalized cache for the case header — this table powers trends. */
export function recordTestCaseRun(row: Omit<TestCaseRunRow, "id">): void {
  getDb().query(
    `INSERT INTO test_case_runs
       (id, test_case_id, task_id, passed, duration_ms, attempts, output, assertions_json, ran_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    row.testCaseId,
    row.taskId,
    row.passed ? 1 : 0,
    row.durationMs,
    row.attempts,
    row.output,
    row.assertionsJson,
    row.ranAt,
  );
}

/** Return per-day pass/fail counts for the last `days` days for one test
 *  case. Used by the sparkline UI. Days with no runs are returned as zero
 *  buckets so the sparkline keeps a uniform x-axis. */
export interface TestCaseTrendDay { date: string; passes: number; fails: number; }
export function getTestCaseTrend(testCaseId: string, days: number): {
  total: number;
  passed: number;
  trend: TestCaseTrendDay[];
} {
  const safeDays = Math.max(1, Math.min(90, Math.floor(days)));
  const since = new Date(Date.now() - safeDays * 86_400_000).toISOString();
  const rows = getDb().query(
    `SELECT substr(ran_at, 1, 10) AS day, passed, COUNT(*) AS n
     FROM test_case_runs
     WHERE test_case_id = ? AND ran_at >= ?
     GROUP BY day, passed`,
  ).all(testCaseId, since) as { day: string; passed: number; n: number }[];

  // Build a date → {passes, fails} map, then materialize an N-day window.
  const map = new Map<string, { passes: number; fails: number }>();
  for (const r of rows) {
    const bucket = map.get(r.day) ?? { passes: 0, fails: 0 };
    if (r.passed) bucket.passes += r.n;
    else bucket.fails += r.n;
    map.set(r.day, bucket);
  }

  const trend: TestCaseTrendDay[] = [];
  let total = 0, passed = 0;
  for (let i = safeDays - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const b = map.get(date) ?? { passes: 0, fails: 0 };
    trend.push({ date, passes: b.passes, fails: b.fails });
    total += b.passes + b.fails;
    passed += b.passes;
  }
  return { total, passed, trend };
}
