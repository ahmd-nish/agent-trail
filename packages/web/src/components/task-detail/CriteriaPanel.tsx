import { useState } from "react";
import type { Task, Guardrail } from "../../../../core/src/types/index.ts";
import { Field } from "./atoms.tsx";

const inputCls = "bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-slate-100 text-sm focus:outline-none focus:border-slate-400 w-full";
const inputSmCls = "bg-slate-800 border border-slate-600 rounded px-2.5 py-1 text-slate-100 text-xs focus:outline-none focus:border-slate-400 w-full";

interface Props {
  task: Task;
  form: Partial<Task>;
  setForm: (updater: (f: Partial<Task>) => Partial<Task>) => void;
  save: (patch: Partial<Task>) => Promise<void>;
}

export function CriteriaPanel({ task, form, setForm, save }: Props) {
  const [criterionInput, setCriterionInput] = useState("");
  const [guardrailInput, setGuardrailInput] = useState("");
  const [guardrailPriority, setGuardrailPriority] = useState(1);

  const f = <K extends keyof Task>(key: K): Task[K] =>
    (form[key] !== undefined ? form[key] : task[key]) as Task[K];

  const currentCriteria: string[] = (f("successCriteria") as string[] | undefined) ?? [];
  const currentGuardrails: Guardrail[] = (f("guardrails") as Guardrail[] | undefined) ?? [];
  const sortedGuardrails = [...currentGuardrails].sort((a, b) => b.priority - a.priority);

  function addCriterion() {
    const val = criterionInput.trim();
    if (!val) return;
    save({ successCriteria: [...currentCriteria, val] });
    setCriterionInput("");
  }

  function addGuardrail() {
    const val = guardrailInput.trim();
    if (!val) return;
    save({ guardrails: [...currentGuardrails, { priority: guardrailPriority, instruction: val }] });
    setGuardrailInput("");
    setGuardrailPriority(currentGuardrails.length + 2);
  }

  return (
    <>
      <Field label="Description">
        <textarea
          rows={6}
          className={`${inputCls} resize-none`}
          value={(form.description as string) ?? task.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          onBlur={() => form.description !== task.description && save({ description: form.description })}
        />
      </Field>

      <Field label="Additional context / prompt">
        <textarea
          rows={3}
          placeholder="Extra instructions injected at runtime…"
          className={`${inputCls} resize-none placeholder:text-slate-600`}
          value={(form.additionalPrompt as string | null) ?? task.additionalPrompt ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, additionalPrompt: e.target.value }))}
          onBlur={() => {
            const val = (form.additionalPrompt ?? "") as string;
            if (val !== (task.additionalPrompt ?? "")) save({ additionalPrompt: val || null });
          }}
        />
      </Field>

      {/* Success criteria */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-slate-400">Success Criteria</span>
        <div className="flex flex-col gap-1.5">
          {currentCriteria.map((c, i) => (
            <div key={i} className="flex items-start gap-2 group">
              <span className="text-xs text-slate-500 mt-0.5 shrink-0">{i + 1}.</span>
              <span className="text-xs text-slate-200 flex-1 leading-relaxed">{c}</span>
              <button
                onClick={() => save({ successCriteria: currentCriteria.filter((_, j) => j !== i) })}
                className="text-slate-600 hover:text-red-400 text-sm leading-none opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >×</button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-1">
          <input
            placeholder="Add criterion…"
            value={criterionInput}
            onChange={(e) => setCriterionInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCriterion()}
            className={`flex-1 ${inputSmCls} placeholder:text-slate-600`}
          />
          <button onClick={addCriterion} className="text-xs px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 shrink-0">Add</button>
        </div>
      </div>

      {/* Guardrails */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-slate-400">Guardrails</span>
        <div className="flex flex-col gap-1.5">
          {sortedGuardrails.map((g, i) => (
            <div key={i} className="flex items-start gap-2 group">
              <span className="text-[10px] font-bold text-amber-500 bg-amber-950 px-1.5 py-0.5 rounded shrink-0 mt-0.5">P{g.priority}</span>
              <span className="text-xs text-slate-200 flex-1 leading-relaxed">{g.instruction}</span>
              <button
                onClick={() => save({ guardrails: currentGuardrails.filter((x) => x !== g) })}
                className="text-slate-600 hover:text-red-400 text-sm leading-none opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >×</button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-1">
          <input
            type="number"
            min={1}
            max={10}
            value={guardrailPriority}
            onChange={(e) => setGuardrailPriority(Number(e.target.value))}
            className="w-12 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs focus:outline-none text-center shrink-0"
            title="Priority (higher = more critical)"
          />
          <input
            placeholder="Add guardrail instruction…"
            value={guardrailInput}
            onChange={(e) => setGuardrailInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addGuardrail()}
            className={`flex-1 ${inputSmCls} placeholder:text-slate-600`}
          />
          <button onClick={addGuardrail} className="text-xs px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 shrink-0">Add</button>
        </div>
      </div>
    </>
  );
}
