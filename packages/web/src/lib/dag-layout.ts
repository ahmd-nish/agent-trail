import type { Task } from "../../../core/src/types/index.ts";

export interface LaidOutNode {
  id: string;
  task: Task;
  x: number;
  y: number;
  level: number;
}

export interface LaidOutEdge {
  id: string;
  source: string;
  target: string;
  active: boolean;
}

export interface DagLayoutOpts {
  nodeWidth?: number;
  nodeHeight?: number;
  hGap?: number;
  vGap?: number;
}

/**
 * Pure DAG layout — level = longest-path depth from a root; y = index within
 * level. Kept dependency-free so it's straightforward to test and can be
 * reused by any DAG-shaped renderer (SVG, canvas, reactflow).
 *
 * Cycles are guarded — a task participating in a cycle gets depth 0 rather
 * than throwing, so the UI stays alive even if the planner ever produces a
 * bad graph (the DAG builder in `packages/core/src/planner/dag.ts` would
 * refuse first, but this is defence in depth).
 */
export function layoutDag(
  tasks: readonly Task[],
  opts: DagLayoutOpts = {},
): { nodes: LaidOutNode[]; edges: LaidOutEdge[] } {
  const {
    nodeWidth = 200,
    nodeHeight = 62,
    hGap = 240,
    vGap = 24,
  } = opts;

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();

  function getDepth(id: string, seen = new Set<string>()): number {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const task = byId.get(id);
    if (!task || task.dependsOn.length === 0) {
      depth.set(id, 0);
      return 0;
    }
    // Filter unknown deps so a broken reference doesn't collapse the level.
    const knownDeps = task.dependsOn.filter((d) => byId.has(d));
    if (knownDeps.length === 0) { depth.set(id, 0); return 0; }
    const d = Math.max(...knownDeps.map((dep) => getDepth(dep, new Set(seen)))) + 1;
    depth.set(id, d);
    return d;
  }

  for (const t of tasks) getDepth(t.id);

  const byDepth = new Map<number, Task[]>();
  for (const t of tasks) {
    const d = depth.get(t.id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(t);
  }

  const nodes: LaidOutNode[] = [];
  for (const [level, levelTasks] of byDepth) {
    levelTasks.forEach((task, i) => {
      nodes.push({
        id: task.id,
        task,
        x: level * hGap,
        y: i * (nodeHeight + vGap),
        level,
      });
    });
  }
  // Node width is exposed for the renderer but not used in positioning;
  // referencing it here keeps opts strictly-typed and consumed.
  void nodeWidth;

  const edges: LaidOutEdge[] = [];
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      edges.push({
        id: `${dep}->${task.id}`,
        source: dep,
        target: task.id,
        active: task.status === "in_progress",
      });
    }
  }

  return { nodes, edges };
}
