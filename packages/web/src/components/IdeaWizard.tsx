import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ArrowLeft, ArrowRight, Sparkles, Check, X, Film } from "lucide-react";
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
type PlanTier = "opus" | "sonnet" | "haiku";

const PLAN_TIERS: { key: PlanTier; label: string; hint: string; recommended?: boolean }[] = [
  { key: "opus",   label: "Opus 4.7",   hint: "top quality — best plan, slowest, most expensive", recommended: true },
  { key: "sonnet", label: "Sonnet 4.6", hint: "solid plan, faster, cheaper" },
  { key: "haiku",  label: "Haiku 4.5",  hint: "quickest, roughest plan — good for tiny ideas" },
];

export function IdeaWizard({ onCancel, onPlanned }: Props) {
  const [idea, setIdea] = useState("");
  const [state, setState] = useState<IdeaState | null>(null);
  const [step, setStep] = useState<"idea" | "question" | "review" | "prd">("idea");
  const [questionIdx, setQuestionIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planTier, setPlanTier] = useState<PlanTier>("opus");
  const [synthesizing, setSynthesizing] = useState(false);

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
      const s = await api.ideas.start(idea.trim(), planTier);
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
    setBusy(true); setSynthesizing(true); setError(null);
    try {
      const updated = await api.ideas.synthesizePrd(state.id, planTier);
      setState(updated);
      setStep("prd");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setSynthesizing(false);
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
        <IdeaStep
          idea={idea}
          onChange={setIdea}
          onNext={beginWizard}
          busy={busy}
          planTier={planTier}
          onTierChange={setPlanTier}
        />
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

      {synthesizing && state && (
        <PrdSynthesisTheater
          ideaText={state.ideaText}
          modelLabel={PLAN_TIERS.find((t) => t.key === planTier)?.label ?? planTier}
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

function IdeaStep({ idea, onChange, onNext, busy, planTier, onTierChange }: {
  idea: string;
  onChange: (s: string) => void;
  onNext: () => void;
  busy: boolean;
  planTier: PlanTier;
  onTierChange: (t: PlanTier) => void;
}) {
  const activeLabel = PLAN_TIERS.find((t) => t.key === planTier)?.label ?? "Opus";
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

      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--fg-faded)" }}>
          Planning model
        </div>
        <div className="grid grid-cols-3 gap-2">
          {PLAN_TIERS.map((t) => {
            const isActive = planTier === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => onTierChange(t.key)}
                disabled={busy}
                className="text-left px-3 py-2 rounded flex flex-col gap-1"
                style={{
                  background: isActive ? "var(--bg-panel-hi)" : "var(--bg-panel)",
                  border: `1px solid ${isActive ? "var(--accent)" : "var(--line)"}`,
                  cursor: busy ? "not-allowed" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[11.5px] font-medium" style={{ color: "var(--fg)" }}>
                    {t.label}
                  </span>
                  {t.recommended && (
                    <span
                      className="text-[8.5px] px-1 py-0.5 rounded uppercase tracking-wide"
                      style={{ background: "var(--accent)", color: "var(--bg)" }}
                    >
                      rec
                    </span>
                  )}
                </div>
                <div className="text-[10px] leading-snug" style={{ color: "var(--fg-dim)" }}>
                  {t.hint}
                </div>
              </button>
            );
          })}
        </div>
      </div>

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
          {busy ? `asking ${activeLabel} for stack options…` : "next"}
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

// ─── Cinematic PRD synthesis overlay ────────────────────────────────────────
// Full-screen director's-slate overlay while the LLM writes the PRD. Cycles
// through fake "scenes" on a timer, streams a rolling ticker of quips, holds
// the progress bar at 95% until the actual API call returns. No signals from
// the LLM — this is purely for feel.

const SYNTH_SCENES: { title: string; blurb: string }[] = [
  { title: "SCENE 01 · reading your idea",   blurb: "picking out the load-bearing nouns" },
  { title: "SCENE 02 · staging the stack",   blurb: "wiring frontend, backend, storage" },
  { title: "SCENE 03 · casting the roles",   blurb: "user personas, jobs, boundaries" },
  { title: "SCENE 04 · scripting user flows", blurb: "signup, main loop, edge cases" },
  { title: "SCENE 05 · plotting the tests",  blurb: "happy path, edges, negatives" },
  { title: "SCENE 06 · final cut",           blurb: "trimming, polishing, printing" },
];

const SYNTH_QUIPS = [
  "> ideating flows…",
  "> naming things (hard, this)",
  "> weighing tradeoffs",
  "> drafting acceptance criteria",
  "> considering the failure modes",
  "> shaping the data model",
  "> negotiating with the DB gods",
  "> humming the theme song",
  "> checking for hidden assumptions",
  "> stress-testing the happy path",
  "> the plot thickens",
  "> reticulating splines",
  "> aligning the star system",
  "> asking: what would the user actually type?",
  "> auditioning route handlers",
  "> weighing REST vs. RPC",
  "> murder-boarding the schema",
  "> teaching the tests to fail first",
  "> negotiating with future-you",
  "> making it delightful, not just correct",
];

function PrdSynthesisTheater({ ideaText, modelLabel }: { ideaText: string; modelLabel: string }) {
  const [elapsed, setElapsed] = useState(0);
  const [scene, setScene] = useState(0);
  const [quips, setQuips] = useState<string[]>([]);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Advance scene every 4s, hold on the last one until the promise resolves
    // (parent unmounts the theater on success).
    const id = setInterval(() => {
      setScene((s) => Math.min(s + 1, SYNTH_SCENES.length - 1));
    }, 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Roll a fresh quip in every ~1.4s. Keeps only the last 5.
    const push = () => {
      setQuips((q) => {
        const next = SYNTH_QUIPS[Math.floor(Math.random() * SYNTH_QUIPS.length)]!;
        // Avoid two identical quips back-to-back — feels lazy.
        const tail = q[q.length - 1] === next && SYNTH_QUIPS.length > 1
          ? SYNTH_QUIPS[(SYNTH_QUIPS.indexOf(next) + 1) % SYNTH_QUIPS.length]!
          : next;
        return [...q, tail].slice(-5);
      });
    };
    push();
    const id = setInterval(push, 1400);
    return () => clearInterval(id);
  }, []);

  // Progress: fill toward 95% over ~24s (avg PRD run), hold there.
  const EXPECTED_MS = 24_000;
  const progressPct = Math.min(95, (elapsed * 1000 / EXPECTED_MS) * 95);
  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  const currentScene = SYNTH_SCENES[scene] ?? SYNTH_SCENES[SYNTH_SCENES.length - 1]!;

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col overflow-hidden"
      style={{ background: "linear-gradient(180deg, #050608 0%, #0a0e14 100%)", padding: 18 }}
    >
      {/* Film-strip top border */}
      <FilmStrip />

      <div className="flex-1 flex flex-col items-center justify-center gap-4 py-4 min-h-0">
        {/* Marquee: NOW SHOWING */}
        <div className="flex items-center gap-2" style={{ color: "var(--fg-faded)" }}>
          <span className="text-[9px] tracking-[0.35em]" style={{ color: "var(--accent)" }}>▲ ▲ ▲</span>
          <span className="text-[10px] tracking-[0.3em] uppercase">now writing</span>
          <span className="text-[9px] tracking-[0.35em]" style={{ color: "var(--accent)" }}>▲ ▲ ▲</span>
        </div>
        <div className="text-[15px] font-medium text-center px-6" style={{ color: "var(--fg)", letterSpacing: "0.02em" }}>
          “{truncateIdea(ideaText)}”
        </div>

        {/* Director's slate */}
        <div
          className="w-full max-w-md rounded relative overflow-hidden"
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--line)",
            padding: "12px 14px",
          }}
        >
          {/* Clapper stripes */}
          <div className="absolute top-0 left-0 right-0 flex" style={{ height: 6 }}>
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} className="flex-1" style={{ background: i % 2 === 0 ? "var(--fg)" : "var(--bg)" }} />
            ))}
          </div>
          <div className="pt-3 flex flex-col gap-3">
            <div className="flex items-center justify-between text-[9px] tracking-[0.25em] uppercase" style={{ color: "var(--fg-faded)" }}>
              <span>take 01</span>
              <span style={{ color: "var(--accent)" }}>{modelLabel.toUpperCase()}</span>
              <span className="tabular-nums">⧗ {mmss}</span>
            </div>
            <div>
              <div className="text-[12px] font-medium" style={{ color: "var(--accent)" }}>
                {currentScene.title}
              </div>
              <div className="text-[10.5px] mt-1" style={{ color: "var(--fg-dim)" }}>
                {currentScene.blurb}
              </div>
            </div>

            {/* Scene dots */}
            <div className="flex items-center gap-1.5">
              {SYNTH_SCENES.map((_, i) => {
                const done = i < scene;
                const active = i === scene;
                return (
                  <div
                    key={i}
                    className="h-1.5 flex-1 rounded-full transition-all"
                    style={{
                      background: done
                        ? "var(--accent)"
                        : active
                          ? "var(--accent)"
                          : "var(--line)",
                      opacity: done ? 0.6 : active ? 1 : 0.5,
                      boxShadow: active ? "0 0 8px var(--accent)" : "none",
                    }}
                  />
                );
              })}
            </div>

            {/* Progress bar */}
            <div>
              <div
                className="w-full h-2 rounded-full overflow-hidden"
                style={{ background: "var(--bg)", border: "1px solid var(--line)" }}
              >
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${progressPct}%`,
                    background: "linear-gradient(90deg, var(--accent) 0%, var(--green) 100%)",
                    boxShadow: "0 0 12px var(--accent)",
                  }}
                />
              </div>
              <div className="flex items-center justify-between mt-1 text-[9px] tabular-nums" style={{ color: "var(--fg-faded)" }}>
                <span>rendering scene {scene + 1} / {SYNTH_SCENES.length}</span>
                <span>{Math.round(progressPct)}%</span>
              </div>
            </div>
          </div>
        </div>

        {/* Rolling teleprompter */}
        <div
          className="w-full max-w-md rounded flex flex-col gap-0.5 min-h-[110px] justify-end"
          style={{
            background: "var(--bg)",
            border: "1px solid var(--line)",
            padding: "10px 12px",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10.5,
          }}
        >
          {quips.map((q, i) => {
            const isLatest = i === quips.length - 1;
            return (
              <div
                key={`${q}-${i}`}
                className={isLatest ? "quip-in" : ""}
                style={{
                  color: isLatest ? "var(--green)" : "var(--fg-dim)",
                  opacity: isLatest ? 1 : Math.max(0.35, 0.4 + i * 0.15),
                }}
              >
                {q}
                {isLatest && <span className="quip-caret">▍</span>}
              </div>
            );
          })}
        </div>

        {/* Reels */}
        <div className="flex items-center gap-4 mt-1" style={{ color: "var(--fg-faded)" }}>
          <ReelSpinner />
          <div className="text-[10px] tracking-[0.2em] uppercase">Please stay in your seat</div>
          <ReelSpinner reverse />
        </div>
      </div>

      <FilmStrip />

      {/* Tiny stylesheet for the two animations — scoped to this overlay. */}
      <style>{`
        @keyframes at-reel-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
        @keyframes at-reel-spin-rev { from { transform: rotate(0); } to { transform: rotate(-360deg); } }
        @keyframes at-quip-in { from { transform: translateY(6px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes at-caret { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }
        .quip-in { animation: at-quip-in 260ms ease-out; }
        .quip-caret { display: inline-block; margin-left: 2px; animation: at-caret 900ms steps(2) infinite; }
      `}</style>
    </div>
  );
}

function FilmStrip() {
  return (
    <div
      className="flex items-center gap-1.5 shrink-0"
      style={{ height: 14, padding: "0 4px" }}
    >
      {Array.from({ length: 26 }).map((_, i) => (
        <div
          key={i}
          style={{
            width: 22,
            height: 10,
            background: "var(--bg-panel)",
            border: "1px solid var(--line)",
            borderRadius: 2,
            opacity: 0.7,
          }}
        />
      ))}
    </div>
  );
}

function ReelSpinner({ reverse = false }: { reverse?: boolean }) {
  return (
    <div
      style={{
        width: 22, height: 22, borderRadius: "50%",
        border: "1.5px solid var(--line)",
        position: "relative",
        animation: `${reverse ? "at-reel-spin-rev" : "at-reel-spin"} 2.4s linear infinite`,
      }}
    >
      {[0, 60, 120, 180, 240, 300].map((deg) => (
        <div
          key={deg}
          style={{
            position: "absolute", top: "50%", left: "50%",
            width: 3, height: 3, borderRadius: "50%",
            background: "var(--fg-faded)",
            transform: `translate(-50%, -50%) rotate(${deg}deg) translateY(-7px)`,
          }}
        />
      ))}
      <Film
        size={9}
        style={{
          position: "absolute", top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          color: "var(--accent)",
        }}
      />
    </div>
  );
}

function truncateIdea(s: string) {
  const clean = s.trim().replace(/\s+/g, " ");
  return clean.length > 90 ? clean.slice(0, 90) + "…" : clean;
}
