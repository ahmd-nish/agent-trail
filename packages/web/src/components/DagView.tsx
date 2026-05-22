import ReactFlow, { Background, Controls, type Node, type Edge } from "reactflow";
import "reactflow/dist/style.css";
import type { Task, TaskStatus } from "../../../core/src/types/index.ts";

const statusColor: Record<TaskStatus, string> = {
  backlog: "#475569",
  ready: "#0369a1",
  in_progress: "#7c3aed",
  blocked: "#b91c1c",
  in_review: "#d97706",
  done: "#15803d",
};

interface Props {
  tasks: Task[];
}

export function DagView({ tasks }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        No tasks yet — create some to see the DAG
      </div>
    );
  }

  // Assign x position by dependency depth level
  const depth = new Map<string, number>();
  const byId = new Map(tasks.map((t) => [t.id, t]));

  function getDepth(id: string, visited = new Set<string>()): number {
    if (depth.has(id)) return depth.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);
    const task = byId.get(id);
    if (!task || task.dependsOn.length === 0) {
      depth.set(id, 0);
      return 0;
    }
    const d = Math.max(...task.dependsOn.map((dep) => getDepth(dep, new Set(visited)))) + 1;
    depth.set(id, d);
    return d;
  }

  tasks.forEach((t) => getDepth(t.id));

  // Group by depth for y positioning
  const byDepth = new Map<number, Task[]>();
  for (const task of tasks) {
    const d = depth.get(task.id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(task);
  }

  const NODE_W = 180;
  const NODE_H = 60;
  const H_GAP = 220;
  const V_GAP = 80;

  const nodes: Node[] = [];
  for (const [level, levelTasks] of byDepth) {
    levelTasks.forEach((task, i) => {
      nodes.push({
        id: task.id,
        position: { x: level * H_GAP, y: i * (NODE_H + V_GAP) },
        data: { label: task.title },
        style: {
          background: "#1e293b",
          border: `2px solid ${statusColor[task.status]}`,
          borderRadius: 8,
          color: "#f1f5f9",
          fontSize: 12,
          width: NODE_W,
          padding: "8px 10px",
        },
      });
    });
  }

  const edges: Edge[] = [];
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      edges.push({
        id: `${dep}->${task.id}`,
        source: dep,
        target: task.id,
        style: { stroke: "#475569" },
        animated: task.status === "in_progress",
      });
    }
  }

  return (
    <div className="h-full w-full">
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background color="#334155" gap={20} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
