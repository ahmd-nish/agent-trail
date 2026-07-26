// PRD_OPEN_SOURCE Phase-3+ addendum — "Idea → Guided plan → Test → Build" wizard.
//
// This module is pure prompt-building + JSON parsing. The claude-CLI call
// lives in `runner.ts` so tests can mock the LLM output cleanly.

export interface WizardOption {
  label: string;
  /** Optional 1-line hint shown under the label. */
  description?: string;
  pros: string[];
  cons: string[];
}

export interface WizardQuestion {
  /** Stable key — used as answers[key]. */
  key: string;
  /** Human-readable question. */
  question: string;
  /** Optional supporting paragraph shown under the question. */
  description?: string;
  options: WizardOption[];
  /** When true, the UI presents chips + multi-select. */
  multiSelect?: boolean;
  /** Sticky recommendation — the LLM's suggested default. */
  recommendedLabel?: string;
}

// The four dimensions every wizard covers. Guarantees a consistent shape
// even when the LLM misbehaves — the runner enforces these keys post-parse.
export const REQUIRED_QUESTION_KEYS = ["frontend", "backend", "database", "packages"] as const;
export type WizardQuestionKey = typeof REQUIRED_QUESTION_KEYS[number];

export interface WizardQuestionSet {
  questions: WizardQuestion[];
}

export function buildQuestionsPrompt(idea: string): string {
  const trimmed = idea.trim().slice(0, 4000);
  return `You are a senior software architect helping a developer scope a new project.
The developer has this idea:

"""
${trimmed}
"""

Propose 3-4 concrete technology choices for EACH of these dimensions, tailored to the idea:
  • frontend — user-facing framework or "none" if pure API/CLI
  • backend — server framework/runtime
  • database — data store
  • packages — key optional add-ons (auth, payments, LLM, jobs, email, etc.); multi-select allowed

Rules:
  • Every option MUST list 2-4 concrete pros and 1-3 concrete cons, in the CONTEXT OF THIS IDEA (not generic).
  • Prefer well-supported, mainstream choices unless the idea implies otherwise.
  • For 'packages', options are add-on categories the user might want; recommendedLabel picks the most important one.
  • Do NOT propose more than 4 options per dimension.
  • Output ONLY a valid JSON object — no markdown fences, no explanation, no surrounding text.

Shape:

{
  "questions": [
    {
      "key": "frontend",
      "question": "Which frontend?",
      "description": "One line of context.",
      "options": [
        {
          "label": "Next.js",
          "description": "React meta-framework with routing + SSR",
          "pros": ["File-based routes match your CRUD idea", "Vercel-ready deploy"],
          "cons": ["More boilerplate than Vite for a small app"]
        }
      ],
      "multiSelect": false,
      "recommendedLabel": "Next.js"
    },
    { "key": "backend",  "question": "...", "options": [...], "recommendedLabel": "..." },
    { "key": "database", "question": "...", "options": [...], "recommendedLabel": "..." },
    { "key": "packages", "question": "...", "options": [...], "multiSelect": true, "recommendedLabel": "..." }
  ]
}`;
}

export interface WizardAnswer {
  /** Either a label from the options[] OR the raw text the user typed when they
   *  picked "Other". Multi-select answers use an array. */
  value: string | string[];
  /** Optional free-text elaboration. */
  note?: string;
}

export type WizardAnswers = Record<string, WizardAnswer>;

export function buildPrdPrompt(idea: string, questions: WizardQuestion[], answers: WizardAnswers): string {
  const trimmed = idea.trim().slice(0, 4000);
  const decisions = questions.map((q) => {
    const a = answers[q.key];
    if (!a) return `- ${q.question}\n  (no answer — treat as "any recommended choice")`;
    const value = Array.isArray(a.value) ? a.value.join(", ") : a.value;
    return `- ${q.question}\n  → ${value}${a.note ? `\n  Note: ${a.note}` : ""}`;
  }).join("\n");

  return `You are a senior product manager translating a scoped idea into a full PRD.

## Idea

"""
${trimmed}
"""

## Stack decisions made by the developer

${decisions}

## Your job

Write a markdown PRD that the planner will use to build a task graph. Include:
  1. **Project name** (short, evocative)
  2. **Problem** (1-2 sentences)
  3. **Users** (who + why)
  4. **Non-goals** (what we're NOT building — prevents scope creep)
  5. **Success metrics** (concrete + measurable)
  6. **Stack** (call out the developer's picks verbatim)
  7. **Features** — a numbered list, each feature described in 2-3 sentences with
     concrete acceptance criteria (bullets). Aim for 6-12 features that together
     cover the idea end-to-end.
  8. **Test coverage requirements** — one paragraph reminding the implementation
     agent to cover happy path + edge + negative cases per feature.

Output MARKDOWN ONLY — no JSON, no code fences around the whole thing. The output
should read like a serious PRD, not a stub.`;
}

// ─── Post-parse validation ───────────────────────────────────────────────────
// The LLM sometimes hallucinates keys or omits pros/cons. We repair-then-validate
// so the wizard is resilient to model chatter without falling over.

export interface ParsedQuestions {
  questions: WizardQuestion[];
  warnings: string[];
}

export function parseAndRepairQuestions(rawJson: string): ParsedQuestions {
  const warnings: string[] = [];
  const cleaned = stripJsonFences(rawJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`wizard: could not parse LLM output as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const obj = parsed as { questions?: unknown };
  if (!obj.questions || !Array.isArray(obj.questions)) {
    throw new Error("wizard: LLM output missing `questions` array");
  }

  const byKey = new Map<string, WizardQuestion>();
  for (const raw of obj.questions) {
    const q = coerceQuestion(raw, warnings);
    if (q) byKey.set(q.key, q);
  }

  // Enforce every required dimension. If the LLM dropped one, we synthesise a
  // placeholder rather than throw — the UI can still show it and prompt a
  // free-text answer.
  const questions: WizardQuestion[] = [];
  for (const key of REQUIRED_QUESTION_KEYS) {
    const q = byKey.get(key);
    if (q) {
      questions.push(q);
    } else {
      warnings.push(`missing dimension "${key}" — inserted placeholder`);
      questions.push(placeholderQuestion(key));
    }
  }
  return { questions, warnings };
}

function coerceQuestion(raw: unknown, warnings: string[]): WizardQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r["key"] === "string" ? (r["key"] as string).trim() : "";
  if (!key || !REQUIRED_QUESTION_KEYS.includes(key as WizardQuestionKey)) {
    warnings.push(`unknown question key "${String(r["key"])}" — dropped`);
    return null;
  }
  const question = typeof r["question"] === "string" ? r["question"] : `Choose your ${key}`;
  const description = typeof r["description"] === "string" ? r["description"] : undefined;
  const multiSelect = r["multiSelect"] === true || key === "packages";
  const recommendedLabel = typeof r["recommendedLabel"] === "string" ? r["recommendedLabel"] : undefined;
  const optionsRaw = Array.isArray(r["options"]) ? r["options"] : [];
  const options: WizardOption[] = optionsRaw
    .slice(0, 4)
    .map((o) => coerceOption(o))
    .filter((o): o is WizardOption => o !== null);
  if (options.length < 2) {
    warnings.push(`question "${key}" had fewer than 2 valid options — inserted defaults`);
    while (options.length < 2) options.push({ label: `Option ${options.length + 1}`, pros: [], cons: [] });
  }
  return { key, question, description, options, multiSelect, recommendedLabel };
}

function coerceOption(raw: unknown): WizardOption | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r["label"] === "string" ? r["label"].trim() : "";
  if (!label) return null;
  const description = typeof r["description"] === "string" ? r["description"] : undefined;
  const pros = Array.isArray(r["pros"])
    ? (r["pros"] as unknown[]).filter((p) => typeof p === "string") as string[]
    : [];
  const cons = Array.isArray(r["cons"])
    ? (r["cons"] as unknown[]).filter((c) => typeof c === "string") as string[]
    : [];
  return { label, description, pros, cons };
}

function placeholderQuestion(key: WizardQuestionKey): WizardQuestion {
  const map: Record<WizardQuestionKey, WizardQuestion> = {
    frontend: {
      key: "frontend", question: "Which frontend?",
      options: [
        { label: "React (Vite)", pros: ["Fast dev loop"], cons: [] },
        { label: "None (API-only)", pros: ["Fewer moving parts"], cons: [] },
      ],
    },
    backend: {
      key: "backend", question: "Which backend?",
      options: [
        { label: "Bun + Hono", pros: ["Zero config", "Fast"], cons: [] },
        { label: "Node + Express", pros: ["Well-known"], cons: [] },
      ],
    },
    database: {
      key: "database", question: "Which database?",
      options: [
        { label: "SQLite", pros: ["Zero infra"], cons: ["Single-writer"] },
        { label: "Postgres", pros: ["Mature"], cons: ["Needs a server"] },
      ],
    },
    packages: {
      key: "packages", question: "Any add-on packages?",
      multiSelect: true,
      options: [
        { label: "Auth", pros: [], cons: [] },
        { label: "Payments", pros: [], cons: [] },
      ],
    },
  };
  return map[key];
}

// The LLM sometimes wraps its JSON in ```json ... ``` fences even when asked
// not to. Strip them so we can parse.
function stripJsonFences(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("```")) {
    const withoutOpener = t.replace(/^```[a-zA-Z]*\n?/, "");
    return withoutOpener.replace(/```\s*$/, "").trim();
  }
  return t;
}

/** Sanity check on the final PRD — must not be empty, must not be JSON. */
export function validateSynthesizedPrd(prd: string): { ok: true } | { ok: false; error: string } {
  const trimmed = prd.trim();
  if (trimmed.length < 100) return { ok: false, error: "PRD too short — likely empty response" };
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return { ok: false, error: "PRD looks like JSON — expected markdown" };
  }
  return { ok: true };
}
