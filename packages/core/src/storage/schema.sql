-- agent-trail v0.1.1 baseline schema.
--
-- This file represents the CURRENT shape of the database. A fresh install
-- runs this once; existing databases skip it (see packages/server/src/db.ts).
-- After v0.1.1 ships, schema changes go through versioned migrations in db.ts
-- rather than edits here.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS boards (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  prd_source          TEXT,
  webhook_url         TEXT,
  default_model       TEXT,
  default_assignee    TEXT NOT NULL DEFAULT 'claude-code',
  default_review_kind TEXT NOT NULL DEFAULT 'none',
  permission_mode     TEXT NOT NULL DEFAULT 'acceptEdits'
                        CHECK(permission_mode IN ('default','acceptEdits','bypassPermissions','plan')),
  implementation_dir  TEXT,
  dev_command         TEXT,
  dev_port            INTEGER,
  execution_timeout_ms INTEGER NOT NULL DEFAULT 1200000,
  workspace_id        TEXT NOT NULL DEFAULT 'local',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_boards_workspace ON boards(workspace_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  board_id              TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'backlog'
                          CHECK(status IN ('backlog','ready','in_progress','blocked','in_review','done')),
  priority              TEXT NOT NULL DEFAULT 'medium'
                          CHECK(priority IN ('low','medium','high','critical')),
  assignee              TEXT NOT NULL DEFAULT 'claude-code'
                          CHECK(assignee IN ('claude-code','codex','gemini','custom')),
  tdd_enabled           INTEGER NOT NULL DEFAULT 1,
  tdd_phase             TEXT NOT NULL DEFAULT 'write_tests'
                          CHECK(tdd_phase IN ('write_tests','implement','verify_tests','implement_only')),
  mcps                  TEXT NOT NULL DEFAULT '[]',
  skills                TEXT NOT NULL DEFAULT '[]',
  subagents             TEXT NOT NULL DEFAULT '[]',
  depends_on            TEXT NOT NULL DEFAULT '[]',
  parallel_group        TEXT,
  active_form           TEXT,
  worktree_path         TEXT,
  success_criteria      TEXT NOT NULL DEFAULT '[]',
  guardrails            TEXT NOT NULL DEFAULT '[]',
  epic                  TEXT,
  sprint                TEXT,
  review_kind           TEXT NOT NULL DEFAULT 'none',
  reviewer              TEXT,
  additional_prompt     TEXT,
  model                 TEXT,
  model_tier            TEXT CHECK(model_tier IN ('haiku','sonnet','opus')),
  component             TEXT,
  external_dependencies TEXT NOT NULL DEFAULT '[]',
  test_cases            TEXT NOT NULL DEFAULT '[]',
  last_error            TEXT,
  workspace_id          TEXT NOT NULL DEFAULT 'local',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_board_status ON tasks(board_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parallel_group ON tasks(parallel_group) WHERE parallel_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_board ON tasks(workspace_id, board_id);

CREATE TABLE IF NOT EXISTS executions (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','running','awaiting_human','completed','failed')),
  agent_kind          TEXT NOT NULL DEFAULT 'claude-code',
  tdd_phase           TEXT NOT NULL,
  mcp_config_path     TEXT,
  worktree_path       TEXT,
  system_prompt       TEXT,
  started_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at         TEXT,
  duration_ms         INTEGER,
  total_input_tokens  INTEGER,
  total_output_tokens INTEGER,
  exit_code           INTEGER,
  error_message       TEXT,
  workspace_id        TEXT NOT NULL DEFAULT 'local'
);

CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id            TEXT PRIMARY KEY,
  execution_id  TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq_num       INTEGER NOT NULL,
  kind          TEXT NOT NULL
                  CHECK(kind IN ('tool_call','tool_result','text','thinking','error','system')),
  tool_name     TEXT,
  tool_input    TEXT,
  tool_result   TEXT,
  text_content  TEXT,
  raw_json      TEXT NOT NULL,
  recorded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  workspace_id  TEXT NOT NULL DEFAULT 'local'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_execution ON telemetry_events(execution_id, seq_num);
CREATE INDEX IF NOT EXISTS idx_telemetry_task ON telemetry_events(task_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id  TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL
                  CHECK(kind IN ('git_diff','test_output','file_list','pr_url','custom')),
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  workspace_id  TEXT NOT NULL DEFAULT 'local'
);

CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS decision_tickets (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id  TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  question      TEXT NOT NULL,
  context       TEXT,
  answer        TEXT,
  answered_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  workspace_id  TEXT NOT NULL DEFAULT 'local'
);

CREATE INDEX IF NOT EXISTS idx_decisions_task ON decision_tickets(task_id);
CREATE INDEX IF NOT EXISTS idx_decisions_unanswered ON decision_tickets(answered_at) WHERE answered_at IS NULL;

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
