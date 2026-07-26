import { useEffect, useMemo, useState } from "react";
import { Loader2, ArrowLeft, ArrowRight, Sparkles, Check, X } from "lucide-react";
import { api } from "../lib/api.ts";
import type { IdeaState, PlanResult, WizardQuestion } from "../lib/api.ts";

interface Props {
  onCancel: () => void;
  onPlanned: (result: PlanResult) => void;
}

/**
 * Idea → Guided plan → Test → Build wizard.
 *
 * Step 0: capture the raw idea.
 * Step 1..N: one question per dimension (frontend / backend / database /
 *            packages), each rendered as tappable option cards with pros/cons.
 * Step N+1: review answers + synthesize PRD via LLM.
 * Step N+2: preview the PRD, kick off /api/boards/plan, hand off.
 */
export function IdeaWizard({ onCancel, onPlanned }: Props) {
  const [idea, setIdea] = useState("");
  const [state, setState] = useState<IdeaState | null>(null);
  const [step, setStep] = useState<"idea" | "question" | "review" | "prd">("idea");
  const [questionIdx, setQuestionIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  const currentQuestion: WizardQuestion | null =
    state && step === "question" ? state.questions[questionIdx] ?? null : null;

  const allAnswered = useMemo(() => {
    if (!state) return false;
    return state.questions.every((q) => {
      const a = state.answers[q.key];
      if (!a) return false;
      if (Array.isArray(a.value)) return a.value.length > 0;
      return typeof a.value === "string" && a.value.trim().length > 0;
    });
  }, [state]);

  async function beginWizard() {
    if (!idea.trim()) return;
    setBusy(true); setError(null);
    try {
      const s = await api.ideas.start(idea.trim());
      setState(s);
      setStep("question");
      setQuestionIdx(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function recordAnswer(key: string, value: string | string[], note?: string) {
    if (!state) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.ideas.answer(state.id, key, value, note);
      setState(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function goNext() {
    if (!state) return;
    if (questionIdx < state.questions.length - 1) {
      setQuestionIdx(questionIdx + 1);
    } else {
      setStep("review");
    }
  }

  function goBack() {
    if (step === "question" && questionIdx > 0) { setQuestionIdx(questionIdx - 1); return; }
    if (step === "question" && questionIdx === 0) { setStep("idea"); return; }
    if (step === "review") { setStep("question"); setQuestionIdx((state?.questions.length ?? 1) - 1); return; }
    if (step === "prd") { setStep("review"); return; }
  }

  async function synthesizePrd() {
    if (!state) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.ideas.synthesizePrd(state.id);
      setState(updated);
      setStep("prd");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function planAndLink() {
    if (!state?.synthesizedPrd) return;
    setPlanning(true); setError(null);
    try {
      const boardName = titleFromMarkdown(state.synthesizedPrd) ?? "New board";
      const result = await api.boards.plan({ prdText: state.synthesizedPrd, name: boardName });
      if (result.board) {
        await api.ideas.linkBoard(state.id, result.board.id).catch(() => { /* non-fatal */ });
      }
      onPlanned(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }

  return (
    <div
      className="flex flex-col h-full max-w-2xl mx-auto px-4 py-6 gap-4"
      style={{ color: "var(--fg)" }}
    >
      <Header step={step} onCancel={onCancel} state={state} questionIdx={questionIdx} />

      {error && (
        <div
          className="text-[11px] px-3 py-2 rounded"
          style={{ background: "var(--bg-panel)", color: "var(--red)", border: "1px solid var(--line)" }}
        >
          {error}
        </div>
      )}

      {step === "idea" && (
        <IdeaStep idea={idea} onChange={setIdea} onNext={beginWizard} busy={busy} />
      )}

      {step === "question" && currentQuestion && state && (
        <QuestionStep
          question={currentQuestion}
          answer={state.answers[currentQuestion.key]}
          onAnswer={(v, note) => recordAnswer(currentQuestion.key, v, note)}
          onNext={goNext}
          onBack={goBack}
          busy={busy}
        />
      )}

      {step === "review" && state && (
        <ReviewStep
          state={state}
          allAnswered={allAnswered}
          busy={busy}
          onEdit={(idx) => { setQuestionIdx(idx); setStep("question"); }}
          onBack={goBack}
          onSynthesize={synthesizePrd}
        />
      )}

      {step === "prd" && state?.synthesizedPrd && (
        <PrdStep
          prd={state.synthesizedPrd}
          onBack={goBack}
          onPlan={planAndLink}
          planning={planning}
        />
      )}
    </div>
  );
}

// ─── Steps ──────────────────────────────────────────────────────────────────

function Header({ step, onCancel, state, questionIdx }: {
  step: "idea" | "question" | "review" | "prd";
  state: IdeaState | null;
  questionIdx: number;
  onCancel: () => void;
}) {
  const totalSteps = 3 + (state?.questions.length ?? 4);
  const currentStep =
    step === "idea" ? 1
    : step === "question" ? 2 + questionIdx
    : step === "review" ? 2 + (state?.questions.length ?? 4)
    : totalSteps;
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Sparkles size={14} style={{ color: "var(--accent)" }} />
        <div className="text-[13px] font-medium">Start from an idea</div>
        <div className="text-[10px]" style={{ color: "var(--fg-faded)" }}>
          step {currentStep} / {totalSteps}
        </div>
      </div>
      <button className="claw-btn" style={{ fontSize: 10, padding: "3px 8px" }} onClick={onCancel}>
        <X size={10} /> cancel
      </button>
    </div>
  );
}

function IdeaStep({ idea, onChange, onNext, busy }: {
  idea: string;
  onChange: (s: string) => void;
  onNext: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px]" style={{ color: "var(--fg-dim)" }}>
        Describe what you want to build. One paragraph is enough — the wizard will ask you
        about the stack next.
      </div>
      <textarea
        autoFocus
        value={idea}
        onChange={(e) => onChange(e.target.value)}
        placeholder="A URL shortener with click analytics, per-user dashboards, and a public API…"
        className="w-full px-3 py-2 rounded text-[12px] leading-5"
        style={{
          background: "var(--bg-panel)", color: "var(--fg)",
          border: "1px solid var(--line)", minHeight: 160, resize: "vertical",
          fontFamily: "inherit",
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px]" style={{ color: "var(--fg-faded)" }}>
          {idea.length} / 4000
        </div>
        <button
          className="claw-btn primary"
          onClick={onNext}
          disabled={busy || !idea.trim() || idea.length > 4000}
          style={{ fontSize: 11, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <ArrowRight size={11} />}
          {busy ? "asking Sonnet for stack options…" : "next"}
        </button>
      </div>
    </div>
  );
}

function QuestionStep({ question, answer, onAnswer, onNext, onBack, busy }: {
  question: WizardQuestion;
  answer: { value: string | string[]; note?: string } | undefined;
  onAnswer: (value: string | string[], note?: string) => void;
  onNext: () => void;
  onBack: () => void;
  busy: boolean;
}) {
  const currentMulti = Array.isArray(answer?.value) ? (answer!.value as string[]) : [];
  const currentSingle = typeof answer?.value === "string" ? (answer!.value as string) : "";
  const [otherText, setOtherText] = useState(
    typeof answer?.value === "string" && !question.options.some((o) => o.label === answer.value)
      ? answer.value
      : "",
  );
  const [otherPicked, setOtherPicked] = useState(otherText.length > 0);

  function toggleMulti(label: string) {
    const next = currentMulti.includes(label)
      ? currentMulti.filter((l) => l !== label)
      : [...currentMulti, label];
    onAnswer(next);
  }

  function pick(label: string) {
    setOtherPicked(false);
    onAnswer(label);
  }

  function commitOther() {
    const val = otherText.trim();
    if (!val) return;
    onAnswer(val);
    setOtherPicked(true);
  }

  const answered =
    question.multiSelect
      ? currentMulti.length > 0
      : (currentSingle.trim().length > 0 || (otherPicked && otherText.trim().length > 0));

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[13px] font-medium">{question.question}</div>
        {question.description && (
          <div className="text-[11px] mt-1" style={{ color: "var(--fg-dim)" }}>{question.description}</div>
        )}
        {question.recommendedLabel && (
          <div className="text-[10px] mt-1" style={{ color: "var(--accent)" }}>
            recommended: {question.recommendedLabel}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {question.options.map((opt) => {
          const isPicked = question.multiSelect
            ? currentMulti.includes(opt.label)
            : currentSingle === opt.label;
          return (
            <button
              key={opt.label}
              onClick={() => (question.multiSelect ? toggleMulti(opt.label) : pick(opt.label))}
              className="text-left px-3 py-2 rounded flex flex-col gap-1.5"
              style={{
                background: isPicked ? "var(--bg-panel-hi)" : "var(--bg-panel)",
                border: `1px solid ${isPicked ? "var(--accent)" : "var(--line)"}`,
                cursor: "pointer",
              }}
            >
              <div className="flex items-center gap-2">
                <div className="text-[12px] font-medium" style={{ color: "var(--fg)" }}>{opt.label}</div>
                {opt.label === question.recommendedLabel && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: "var(--accent)", color: "var(--bg)" }}>
                    rec
                  </span>
                )}
                {isPicked && <Check size={11} style={{ color: "var(--accent)" }} />}
              </div>
              {opt.description && (
                <div className="text-[10.5px]" style={{ color: "var(--fg-dim)" }}>{opt.description}</div>
              )}
              <div className="grid grid-cols-2 gap-2 mt-1">
                <div>
                  <div className="text-[9px] uppercase tracking-wide" style={{ color: "var(--green)" }}>
                    pros
                  </div>
                  <ul className="text-[10.5px] list-disc pl-4" style={{ color: "var(--fg-dim)" }}>
                    {opt.pros.map((p) => <li key={p}>{p}</li>)}
                    {opt.pros.length === 0 && <li style={{ color: "var(--fg-faded)" }}>—</li>}
                  </ul>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-wide" style={{ color: "var(--red)" }}>
                    cons
                  </div>
                  <ul className="text-[10.5px] list-disc pl-4" style={{ color: "var(--fg-dim)" }}>
                    {opt.cons.map((c) => <li key={c}>{c}</li>)}
                    {opt.cons.length === 0 && <li style={{ color: "var(--fg-faded)" }}>—</li>}
                  </ul>
                </div>
              </div>
            </button>
          );
        })}

        {/* "Other" (single-select only — multi-select is already free-form via chip picking) */}
        {!question.multiSelect && (
          <div
            className="px-3 py-2 rounded flex flex-col gap-1.5"
            style={{
              background: otherPicked ? "var(--bg-panel-hi)" : "var(--bg-panel)",
              border: `1px solid ${otherPicked ? "var(--accent)" : "var(--line)"}`,
            }}
          >
            <div className="text-[10.5px]" style={{ color: "var(--fg-dim)" }}>
              or type your own:
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder="e.g. SvelteKit"
                className="flex-1 px-2 py-1 rounded text-[11px]"
                style={{ background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--line)" }}
                onKeyDown={(e) => { if (e.key === "Enter") commitOther(); }}
              />
              <button
                className="claw-btn"
                onClick={commitOther}
                disabled={!otherText.trim()}
                style={{ fontSize: 10, padding: "3px 8px" }}
              >
                use this
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 mt-1">
        <button
          className="claw-btn"
          onClick={onBack}
          style={{ fontSize: 10, padding: "4px 10px", display: "flex", alignItems: "center", gap: 5 }}
        >
          <ArrowLeft size={10} /> back
        </button>
        <button
          className="claw-btn primary"
          onClick={onNext}
          disabled={busy || !answered}
          style={{ fontSize: 11, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <ArrowRight size={11} />}
          next
        </button>
      </div>
    </div>
  );
}

function ReviewStep({ state, allAnswered, busy, onEdit, onBack, onSynthesize }: {
  state: IdeaState;
  allAnswered: boolean;
  busy: boolean;
  onEdit: (idx: number) => void;
  onBack: () => void;
  onSynthesize: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[13px] font-medium">Review your picks</div>
        <div className="text-[11px] mt-1" style={{ color: "var(--fg-dim)" }}>
          These become the stack section of the synthesized PRD. Click any row to edit.
        </div>
      </div>

      <div className="rounded overflow-hidden" style={{ border: "1px solid var(--line)" }}>
        <div className="px-3 py-2 text-[11px]" style={{ background: "var(--bg-panel)", color: "var(--fg-dim)" }}>
          <span className="font-medium" style={{ color: "var(--fg)" }}>Idea:</span> {state.ideaText}
        </div>
        {state.questions.map((q, idx) => {
          const a = state.answers[q.key];
          const shown = !a
            ? "(not answered)"
            : Array.isArray(a.value) ? a.value.join(", ") : a.value;
          return (
            <button
              key={q.key}
              onClick={() => onEdit(idx)}
              className="w-full text-left px-3 py-2 flex items-center justify-between"
              style={{ borderTop: "1px solid var(--line)", background: "var(--bg)" }}
            >
              <div className="flex flex-col">
                <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--fg-faded)" }}>
                  {q.key}
                </div>
                <div className="text-[12px]" style={{ color: a ? "var(--fg)" : "var(--red)" }}>
                  {shown}
                </div>
                {a?.note && (
                  <div className="text-[10px] italic" style={{ color: "var(--fg-dim)" }}>note: {a.note}</div>
                )}
              </div>
              <div className="text-[10px]" style={{ color: "var(--accent)" }}>edit</div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 mt-1">
        <button
          className="claw-btn"
          onClick={onBack}
          style={{ fontSize: 10, padding: "4px 10px", display: "flex", alignItems: "center", gap: 5 }}
        >
          <ArrowLeft size={10} /> back
        </button>
        <button
          className="claw-btn primary"
          onClick={onSynthesize}
          disabled={busy || !allAnswered}
          style={{ fontSize: 11, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          {busy ? "writing your PRD…" : "generate PRD"}
        </button>
      </div>
    </div>
  );
}

function PrdStep({ prd, onBack, onPlan, planning }: {
  prd: string;
  onBack: () => void;
  onPlan: () => void;
  planning: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 min-h-0 flex-1">
      <div>
        <div className="text-[13px] font-medium">Your generated PRD</div>
        <div className="text-[11px] mt-1" style={{ color: "var(--fg-dim)" }}>
          Reads a lot like a real spec because Sonnet just wrote it. Approve to hand off to
          the planner and get a task graph.
        </div>
      </div>
      <div
        className="rounded p-3 text-[11.5px] leading-5 overflow-auto"
        style={{
          background: "var(--bg-panel)", color: "var(--fg-dim)",
          border: "1px solid var(--line)", whiteSpace: "pre-wrap", fontFamily: "inherit",
          maxHeight: "60vh",
        }}
      >
        {prd}
      </div>
      <div className="flex items-center justify-between gap-2 mt-1">
        <button
          className="claw-btn"
          onClick={onBack}
          style={{ fontSize: 10, padding: "4px 10px", display: "flex", alignItems: "center", gap: 5 }}
        >
          <ArrowLeft size={10} /> back
        </button>
        <button
          className="claw-btn primary"
          onClick={onPlan}
          disabled={planning}
          style={{ fontSize: 11, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}
        >
          {planning ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          {planning ? "planning…" : "plan tasks & create board"}
        </button>
      </div>
    </div>
  );
}

function titleFromMarkdown(md: string): string | null {
  const m = md.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() ?? null;
}
