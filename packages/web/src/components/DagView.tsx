import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  type Node,
  type Edge,
} from "reactflow";
import "reactflow/dist/style.css";
import type { Task, TaskStatus } from "../../../core/src/types/index.ts";
import { layoutDag } from "../lib/dag-layout.ts";

// Status → border color, kept in sync with TaskCard.tsx accents (see
// index.css CLAW palette). Nodes stay dark; only the border communicates
// state, matching how the kanban cards read across the whole app.
const BORDER_FOR_STATUS: Record<TaskStatus, string> = {
  backlog:     "var(--fg-faded)",
  ready:       "var(--blue)",
  in_progress: "var(--green)",
  blocked:     "var(--red)",
  in_review:   "var(--purple)",
  done:        "rgba(94,232,157,0.5)",
};

interface Props {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

/**
 * PRD 1.3 — DAG view. Restores the reactflow-based dependency graph, retuned
 * to the CLAW theme. Nodes are clickable → open TaskDetail. Edges into any
 * `in_progress` task animate as the "current work" signal.
 *
 * Kept intentionally simple: level = longest-path depth from a root; y = index
 * within level. Good enough for the 4–12 task graphs the planner emits.
 */
export function DagView({ tasks, onTaskClick }: Props) {
  const { nodes, edges } = useMemo(() => buildFlow(tasks), [tasks]);

  if (tasks.length === 0) {
    return (
      <div
        className="flex items-center justify-center h-full text-[11px]"
        style={{ color: "var(--fg-faded)" }}
      >
        // no tasks yet — plan a PRD to see the DAG
      </div>
    );
  }

  return (
    <div
      className="h-full w-full rounded"
      style={{ background: "var(--bg-panel)", border: "1px solid var(--line-dim)" }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(_, node) => {
          const task = tasks.find((t) => t.id === node.id);
          if (task) onTaskClick(task);
        }}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={2}
      >
        <Background color="var(--line-dim)" gap={20} />
        <Controls
          showInteractive={false}
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--line)",
          }}
        />
      </ReactFlow>
    </div>
  );
}

function buildFlow(tasks: Task[]): { nodes: Node[]; edges: Edge[] } {
  const { nodes: laidOut, edges: baseEdges } = layoutDag(tasks);

  const nodes: Node[] = laidOut.map(({ id, task, x, y }) => {
    const isRunning = task.status === "in_progress";
    const isAwaiting = task.status === "blocked" && !!task.activeForm;
    const border = BORDER_FOR_STATUS[task.status];
    return {
      id,
      position: { x, y },
      data: {
        label: (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              textAlign: "left",
              padding: "4px 6px",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: isRunning
                  ? "var(--green)"
                  : isAwaiting
                  ? "var(--amber)"
                  : task.status === "done"
                  ? "var(--fg-faded)"
                  : "var(--fg)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {task.title}
            </span>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span
                style={{
                  fontSize: 9,
                  color: "var(--fg-faded)",
                  textTransform: "lowercase",
                }}
              >
                {task.status.replace("_", " ")}
              </span>
              {task.modelTier && (
                <span
                  style={{
                    fontSize: 9,
                    color:
                      task.modelTier === "opus"
                        ? "var(--purple)"
                        : task.modelTier === "haiku"
                        ? "var(--fg-faded)"
                        : "var(--blue)",
                    border: "1px solid var(--line)",
                    padding: "0 4px",
                    borderRadius: 2,
                  }}
                >
                  {task.modelTier}
                </span>
              )}
            </div>
          </div>
        ),
      },
      style: {
        background: "var(--bg-pane)",
        border: `1px solid ${border}`,
        borderRadius: 6,
        color: "var(--fg)",
        width: 200,
        padding: 0,
        fontSize: 11,
        boxShadow: isRunning
          ? "0 0 12px 1px rgba(94,232,157,0.25)"
          : "none",
      },
    };
  });

  const edges: Edge[] = baseEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: e.active,
    style: {
      stroke: e.active ? "var(--green)" : "var(--line)",
      strokeWidth: e.active ? 1.5 : 1,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: e.active ? "var(--green)" : "var(--line)",
    },
  }));

  return { nodes, edges };
}
