// SQLite DDL for the knowledge_events table — doc §4.1, adapted for the
// local SQLite mirror. Postgres version (with pgvector + tsvector) is
// added by the relay in a later phase (§4.6).
//
// The migration in `packages/server/src/db.ts` imports this string so the
// core module owns the schema of its own table. Keeps the two in sync.

export const KNOWLEDGE_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS knowledge_events (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL DEFAULT 'local',
  project_id     TEXT NOT NULL DEFAULT 'local',
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  actor_name     TEXT NOT NULL,
  task_id        TEXT,
  execution_id   TEXT,
  type           TEXT NOT NULL,
  scope          TEXT NOT NULL,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  paths          TEXT NOT NULL DEFAULT '[]',
  confidence     TEXT NOT NULL,
  valid_from     TEXT NOT NULL,
  supersedes     TEXT,
  superseded_by  TEXT,
  content_hash   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  FOREIGN KEY (supersedes)    REFERENCES knowledge_events(id),
  FOREIGN KEY (superseded_by) REFERENCES knowledge_events(id)
);
`;

export const KNOWLEDGE_EVENTS_INDEXES = [
  // Cursor tail — the sync protocol's fundamental query (§4.6).
  "CREATE INDEX IF NOT EXISTS idx_ke_cursor ON knowledge_events(workspace_id, project_id, id)",
  // fold() by type — active events only, most recent first.
  "CREATE INDEX IF NOT EXISTS idx_ke_active_type ON knowledge_events(type, superseded_by, valid_from DESC)",
  // dedupe on backfill / replay.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ke_content_hash ON knowledge_events(workspace_id, project_id, content_hash)",
  // scope filters — module:<path> and task:<id> lookups.
  "CREATE INDEX IF NOT EXISTS idx_ke_scope ON knowledge_events(scope)",
];
