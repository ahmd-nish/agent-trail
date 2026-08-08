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

// §4.3 seed — FTS5 virtual table + triggers for the "BM25 half" of hybrid
// retrieval. Vector kNN + RRF fusion lands in a follow-up when the
// embedding pipeline (nomic-embed-text 256d Matryoshka) is in place;
// until then FTS5 alone is dramatically better than LIKE, and it's
// available with zero extra dependencies on bun:sqlite.
// §J — the join. Asserted edges only: claims about which knowledge applies to
// which code. The DERIVED code graph (symbols, call edges) deliberately has no
// table here — an external index owns it, it rebuilds in minutes, and it is
// never synced. This table is the small, precious half that cannot be
// regenerated if lost, so it is append-only and syncs like the event log.
export const KNOWLEDGE_EDGES_DDL = `
CREATE TABLE IF NOT EXISTS knowledge_edges (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'local',
  project_id    TEXT NOT NULL DEFAULT 'local',
  src           TEXT NOT NULL,
  dst           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 1.0,
  resolver      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
`;

export const KNOWLEDGE_EDGES_INDEXES = [
  // Q1's access path: "what governs these URNs". The hot one.
  "CREATE INDEX IF NOT EXISTS idx_kedge_dst ON knowledge_edges(dst, kind)",
  // Q3 walks outward from an event.
  "CREATE INDEX IF NOT EXISTS idx_kedge_src ON knowledge_edges(src, kind)",
  // Grow-only: re-running the emitter must not duplicate an edge.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_kedge_hash ON knowledge_edges(workspace_id, project_id, content_hash)",
];

export const KNOWLEDGE_EVENTS_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_events_fts USING fts5(
  subject,
  body,
  content='knowledge_events',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
`;

export const KNOWLEDGE_EVENTS_FTS_TRIGGERS = [
  // Keep the FTS index in sync with the underlying table. append-only writes
  // in the store.ts path guarantee INSERT is the primary case; DELETE is used
  // by nothing today but the trigger exists so future compaction is safe.
  `CREATE TRIGGER IF NOT EXISTS ke_fts_ai AFTER INSERT ON knowledge_events BEGIN
     INSERT INTO knowledge_events_fts(rowid, subject, body) VALUES (new.rowid, new.subject, new.body);
   END;`,
  `CREATE TRIGGER IF NOT EXISTS ke_fts_ad AFTER DELETE ON knowledge_events BEGIN
     INSERT INTO knowledge_events_fts(knowledge_events_fts, rowid, subject, body) VALUES('delete', old.rowid, old.subject, old.body);
   END;`,
  `CREATE TRIGGER IF NOT EXISTS ke_fts_au AFTER UPDATE ON knowledge_events BEGIN
     INSERT INTO knowledge_events_fts(knowledge_events_fts, rowid, subject, body) VALUES('delete', old.rowid, old.subject, old.body);
     INSERT INTO knowledge_events_fts(rowid, subject, body) VALUES (new.rowid, new.subject, new.body);
   END;`,
];

