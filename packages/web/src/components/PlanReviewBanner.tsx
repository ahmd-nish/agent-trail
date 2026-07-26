import { useState } from "react";
import { Loader2, ShieldCheck, ClipboardCheck, X, AlertTriangle } from "lucide-react";
import { api } from "../lib/api.ts";
import type { Board, Task } from "../../../core/src/types/index.ts";

interface Props {
  board: Board;
  tasks: Task[];
  onApproved: (board: Board) => void;
}

/**
 * §C plan-review + approval banner.
 * Renders when the board's approvedAt is null — task execution is server-side
 * blocked until the user hits "Approve & Start Building".
 */
export function PlanReviewBanner({ board, tasks, onApproved }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setApproving(true);
    setError(null);
    try {
      const updated = await api.boards.approve(board.id);
      onApproved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }

  const coverage = summariseCoverage(tasks);

  return (
    <div
      className="mx-4 my-2 rounded"
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--accent)",
        color: "var(--fg)",
      }}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldCheck size={14} style={{ color: "var(--accent)" }} />
          <div className="flex flex-col min-w-0">
            <div className="text-[12px] font-medium">Plan pending review</div>
            <div className="text-[10.5px]" style={{ color: "var(--fg-dim)" }}>
              {tasks.length} task{tasks.length === 1 ? "" : "s"} planned · {coverage.summary}
              {coverage.warnings > 0 && (
                <span style={{ color: "var(--red)" }}> · {coverage.warnings} coverage warning{coverage.warnings === 1 ? "" : "s"}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="claw-btn"
            onClick={() => setShowDetails((s) => !s)}
            style={{ fontSize: 10, padding: "3px 8px", display: "flex", alignItems: "center", gap: 4 }}
          >
            <ClipboardCheck size={10} />
            {showDetails ? "hide plan" : "review plan"}
          </button>
          <button
            className="claw-btn primary"
            onClick={approve}
            disabled={approving}
            style={{ fontSize: 11, padding: "4px 10px", display: "flex", alignItems: "center", gap: 5 }}
          >
            {approving ? <Loader2 size={11} className="animate-spin" /> : <ShieldCheck size={11} />}
            {approving ? "approving…" : "approve & start building"}
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-1 text-[10.5px]" style={{ color: "var(--red)", borderTop: "1px solid var(--line)" }}>
          {error}
        </div>
      )}

      {showDetails && (
        <div style={{ borderTop: "1px solid var(--line)" }}>
          <div className="px-3 py-2 max-h-72 overflow-auto">
            <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: "var(--fg-faded)" }}>
              Task plan — click through the board to edit any task before approving.
            </div>
            <ul className="flex flex-col gap-1.5">
              {tasks.map((t) => {
                const cov = tallyCategories(t.testCases ?? []);
                const criteriaCount = (t.successCriteria ?? []).length;
                const covWarn =
                  criteriaCount > 0 && (cov.happy === 0 || cov.negative === 0);
                return (
                  <li
                    key={t.id}
                    className="px-2 py-1.5 rounded"
                    style={{ background: "var(--bg)", border: "1px solid var(--line)" }}
                  >
                    <div className="flex items-center gap-2">
                      <div className="text-[12px] font-medium">{t.title}</div>
                      <div className="text-[10px]" style={{ color: "var(--fg-faded)" }}>
                        {t.tddEnabled ? "TDD" : "single-shot"} · {t.modelTier ?? "sonnet"}
                      </div>
                      {covWarn && (
                        <span
                          className="flex items-center gap-1 text-[9.5px]"
                          style={{ color: "var(--red)" }}
                          title="Success criterion is missing happy or negative coverage"
                        >
                          <AlertTriangle size={10} /> coverage
                        </span>
                      )}
                    </div>
                    {criteriaCount > 0 && (
                      <div className="text-[10px] mt-0.5" style={{ color: "var(--fg-dim)" }}>
                        {criteriaCount} criteria · tests: {cov.total}
                        {cov.total > 0 && (
                          <>
                            {" "}(
                            <CatChip label="happy"    n={cov.happy}    warn={cov.happy === 0} />
                            <CatChip label="negative" n={cov.negative} warn={cov.negative === 0} />
                            {cov.edge     > 0 && <CatChip label="edge"     n={cov.edge}     warn={false} />}
                            {cov.error    > 0 && <CatChip label="error"    n={cov.error}    warn={false} />}
                            {cov.boundary > 0 && <CatChip label="boundary" n={cov.boundary} warn={false} />}
                            )
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function CatChip({ label, n, warn }: { label: string; n: number; warn: boolean }) {
  return (
    <span
      style={{
        color: warn ? "var(--red)" : "var(--fg-dim)",
        fontWeight: warn ? 600 : 400,
        marginRight: 6,
      }}
    >
      {label}:{n}
    </span>
  );
}

function tallyCategories(cases: NonNullable<Task["testCases"]>): {
  total: number; happy: number; negative: number; edge: number; error: number; boundary: number; perf: number;
} {
  const t = { total: cases.length, happy: 0, negative: 0, edge: 0, error: 0, boundary: 0, perf: 0 };
  for (const c of cases) {
    const cat = (c.category ?? "happy") as keyof typeof t;
    if (cat in t) (t as Record<string, number>)[cat] += 1;
  }
  return t;
}

function summariseCoverage(tasks: Task[]): { summary: string; warnings: number } {
  let totalCases = 0;
  let happy = 0;
  let negative = 0;
  let taskWarnings = 0;
  for (const t of tasks) {
    const cases = t.testCases ?? [];
    totalCases += cases.length;
    const cov = tallyCategories(cases);
    happy += cov.happy;
    negative += cov.negative;
    if ((t.successCriteria?.length ?? 0) > 0 && (cov.happy === 0 || cov.negative === 0)) {
      taskWarnings += 1;
    }
  }
  return {
    summary: `${totalCases} test cases (${happy} happy / ${negative} negative)`,
    warnings: taskWarnings,
  };
}

// Suppress unused import warning under strict tsconfig.
void X;
