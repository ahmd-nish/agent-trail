// PRD_OPEN_SOURCE 2.4 — the generic AgentAdapter contract.
//
// Every AI-coding-agent CLI adapter (claude, codex, gemini, aider, ...) is a
// module that exports a function matching `AgentAdapter`. The execution
// manager holds a REGISTRY of these keyed by `Task.assignee` and dispatches
// at spawn time. Adding a new adapter requires only:
//   1. A file at `packages/core/src/adapters/<name>.ts` exporting `spawnFoo`
//   2. A one-line registration in `adapters/index.ts`
//   3. A test scenario in the file's *.test.ts covering the happy path
//
// The adapter's job is to translate the shared Task + callbacks contract into
// whichever flags + streaming format the underlying CLI understands, then
// emit `StreamEvent`s (from ../types/stream-json.ts) back to the callbacks.

import type { ChildProcess } from "node:child_process";
import type { Task, PermissionMode, AgentKind } from "../types/index.ts";
import type { StreamEvent, StreamResultEvent } from "../types/stream-json.ts";

export interface AdapterCallbacks {
  /** One event per line of the CLI's stream-json output.
   *  `raw` is the JSON line as-received; `parsed` is our typed view. */
  onEvent(raw: string, parsed: StreamEvent): void;
  /** Terminal event — usage counts + duration + session id. */
  onComplete(result: StreamResultEvent): void;
  /** Any fatal / non-recoverable adapter error. */
  onError(err: Error): void;
}

export interface SpawnOpts {
  task: Task;
  worktreePath: string;
  /** MCP config path — pass through to whichever CLI supports MCP. */
  mcpConfigPath: string | null;
  permissionMode: PermissionMode;
  /** Hard SIGKILL after this many ms — enforced by the adapter's driver. */
  timeoutMs?: number;
  /** PRD 2.2 — resume prior session by id (if the CLI supports it). Fall
   *  through to a fresh session otherwise, don't error. */
  resumeSessionId?: string;
  callbacks: AdapterCallbacks;
}

export type AgentAdapter = (opts: SpawnOpts) => ChildProcess | null;

/**
 * Registry — keyed by Task.assignee. Adapter modules register themselves
 * lazily by importing this and calling `registerAdapter`.
 *
 * Kept as a mutable map (rather than a fixed record) so plugins bundled in
 * a downstream repo can add their own adapter at runtime.
 */
const REGISTRY = new Map<AgentKind, AgentAdapter>();

export function registerAdapter(kind: AgentKind, adapter: AgentAdapter): void {
  REGISTRY.set(kind, adapter);
}

export function getAdapter(kind: AgentKind): AgentAdapter | undefined {
  return REGISTRY.get(kind);
}

export function listAdapters(): AgentKind[] {
  return Array.from(REGISTRY.keys());
}
