import { useEffect, useState } from "react";
import { Wand2, FileText, Loader2 } from "lucide-react";
import { api } from "../lib/api.ts";
import type { PlanResult, ExampleFile } from "../lib/api.ts";

interface Props {
  onPlanned: (result: PlanResult) => void;
  onOpenPlan: () => void;
}

/**
 * Empty state shown when the user has no boards yet.
 * The 1-click "Try a sample PRD" button plans a bundled example and opens the DAG.
 * Removes the "what do I type?" wall for first-time visitors.
 */
export function EmptyBoardState({ onPlanned, onOpenPlan }: Props) {
  const [examples, setExamples] = useState<ExampleFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.examples.list().then(setExamples).catch(() => setExamples([]));
  }, []);

  async function planExample(name: string) {
    setLoading(true);
    setError(null);
    try {
      const { content } = await api.examples.get(name);
      const boardName = titleFromMarkdown(content) ?? name.replace(/\.md$/, "");
      const result = await api.boards.plan({ prdText: content, name: boardName });
      onPlanned(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Pick "sample-prd.md" first if present, else the first example.
  const primary = examples.find((e) => e.name === "sample-prd.md") ?? examples[0];
  const secondary = examples.filter((e) => e !== primary).slice(0, 3);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6" style={{ color: "var(--fg-dim)" }}>
      <div className="flex flex-col items-center gap-2 max-w-md text-center px-4">
        <div className="text-[13px] font-medium" style={{ color: "var(--fg)" }}>
          drop in a PRD and get a task graph
        </div>
        <div className="text-[11px]" style={{ color: "var(--fg-faded)" }}>
          agent-trail plans the work, runs Claude Code on parallelizable tasks under a TDD gate,
          and pings you when a human decision is needed.
        </div>
      </div>

      {error && (
        <div className="text-[11px] px-3 py-2 rounded" style={{ background: "var(--bg-panel)", color: "var(--red)", border: "1px solid var(--line)" }}>
          {error}
        </div>
      )}

      <div className="flex flex-col items-center gap-2">
        {primary && (
          <button
            className="claw-btn primary"
            onClick={() => planExample(primary.name)}
            disabled={loading}
            style={{ fontSize: 11, padding: "6px 14px", display: "flex", alignItems: "center", gap: 6 }}
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
            {loading ? "planning…" : `plan the sample PRD: ${primary.title}`}
          </button>
        )}

        <button
          className="claw-btn"
          onClick={onOpenPlan}
          disabled={loading}
          style={{ fontSize: 10, padding: "4px 10px", display: "flex", alignItems: "center", gap: 5 }}
        >
          <FileText size={10} /> paste your own PRD
        </button>
      </div>

      {secondary.length > 0 && (
        <div className="flex flex-col items-center gap-1.5">
          <div className="text-[10px]" style={{ color: "var(--fg-faded)" }}>// or try:</div>
          <div className="flex gap-2 flex-wrap justify-center max-w-md">
            {secondary.map((ex) => (
              <button
                key={ex.name}
                onClick={() => planExample(ex.name)}
                disabled={loading}
                className="claw-chip"
                style={{ fontSize: 10, cursor: "pointer" }}
              >
                {ex.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function titleFromMarkdown(md: string): string | null {
  const m = md.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim().replace(/^PRD:\s*/i, "") ?? null;
}
