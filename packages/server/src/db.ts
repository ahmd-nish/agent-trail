import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board, Task, TaskStatus, Priority, AgentKind, TddPhase } from "../../core/src/types/index.ts";

const schemaPath = join(import.meta.dir, "../../core/src/storage/schema.sql");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database(join(process.cwd(), "agent-trail.db"));
  const schema = readFileSync(schemaPath, "utf-8");
  _db.exec(schema);
  return _db;
}

// ─── Row mappers ───────────────────────────────────────────────────────────────

type BoardRow = {
  id: string;
  name: string;
  prd_source: string | null;
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
  created_at: string;
  updated_at: string;
};

export function rowToBoard(row: BoardRow): Board {
  return {
    id: row.id,
    name: row.name,
    prdSource: row.prd_source,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
