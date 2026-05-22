import type { Task } from "../types/index.ts";

export interface DagResult {
  ordered: Task[];
  parallelGroups: Map<string, Task[]>;
}

/**
 * Topological sort + parallel group assignment.
 *
 * Parallel group: tasks that share the same set of immediate predecessors
 * and have no ordering constraint between themselves. They get the same
 * `parallelGroup` UUID so the dispatcher can run them concurrently.
 *
 * Throws on cycle or unknown dependsOn reference.
 */
export function buildDag(tasks: Task[]): DagResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // validate all dependsOn references
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) {
        throw new Error(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  const successors = new Map<string, string[]>(tasks.map((t) => [t.id, []]));

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      successors.get(dep)!.push(task.id);
    }
  }

  // Process level-by-level so we can assign parallel groups per level
  const ordered: Task[] = [];
  const parallelGroups = new Map<string, Task[]>();

  let queue = tasks.filter((t) => (inDegree.get(t.id) ?? 0) === 0);

  while (queue.length > 0) {
    // All tasks in the current queue are at the same "level" — mutually independent
    const groupId = crypto.randomUUID();
    parallelGroups.set(groupId, []);

    const nextQueue: Task[] = [];

    for (const task of queue) {
      const updated: Task = { ...task, parallelGroup: groupId };
      ordered.push(updated);
      byId.set(task.id, updated);
      parallelGroups.get(groupId)!.push(updated);

      for (const succ of successors.get(task.id) ?? []) {
        const newDegree = (inDegree.get(succ) ?? 0) - 1;
        inDegree.set(succ, newDegree);
        if (newDegree === 0) {
          nextQueue.push(byId.get(succ)!);
        }
      }
    }

    queue = nextQueue;
  }

  if (ordered.length !== tasks.length) {
    throw new Error(
      `Cycle detected in task graph — ${tasks.length - ordered.length} task(s) could not be ordered`,
    );
  }

  return { ordered, parallelGroups };
}
