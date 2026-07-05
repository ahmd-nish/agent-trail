/**
 * Editor for the typed-assertion list on a TestCase (Phase 2).
 *
 * Renders the existing assertion list with per-kind inline editors plus an
 * "+ Add assertion" dropdown. Designed to live alongside the legacy
 * Status/Body-Contains fields — both can coexist; deriveAssertions() prefers
 * the explicit list when non-empty.
 */

import { useState } from "react";
import { Plus, X as XIcon } from "lucide-react";
import type { Assertion } from "../../../../core/src/types/index.ts";

interface Props {
  kind: "api" | "shell";
  assertions: Assertion[];
  onChange: (next: Assertion[]) => void;
}

// Templates for each new assertion kind. Picked from the dropdown.
const API_TEMPLATES: { label: string; build: () => Assertion }[] = [
  { label: "Status code equals…",        build: () => ({ kind: "status", equals: 200 }) },
  { label: "Status code in […]",         build: () => ({ kind: "status_in", values: [200, 201] }) },
  { label: "Header equals/matches…",     build: () => ({ kind: "header", name: "Content-Type", equals: "application/json" }) },
  { label: "Body contains…",             build: () => ({ kind: "body_contains", text: "" }) },
  { label: "Body matches regex…",        build: () => ({ kind: "body_matches", pattern: "" }) },
  { label: "JSON path equals/matches…",  build: () => ({ kind: "json_path", path: "$.id", equals: "" }) },
  { label: "Response time < N ms",       build: () => ({ kind: "response_time_ms", lt: 500 }) },
];

const SHELL_TEMPLATES: { label: string; build: () => Assertion }[] = [
  { label: "Exit code equals…",          build: () => ({ kind: "exit_code", equals: 0 }) },
  { label: "Body contains…",             build: () => ({ kind: "body_contains", text: "" }) },
  { label: "Body matches regex…",        build: () => ({ kind: "body_matches", pattern: "" }) },
  { label: "Response time < N ms",       build: () => ({ kind: "response_time_ms", lt: 5000 }) },
];

export function AssertionListEditor({ kind, assertions, onChange }: Props) {
  const [adding, setAdding] = useState(false);
  const templates = kind === "api" ? API_TEMPLATES : SHELL_TEMPLATES;

  const update = (i: number, next: Assertion) => {
    const arr = [...assertions];
    arr[i] = next;
    onChange(arr);
  };
  const remove = (i: number) => onChange(assertions.filter((_, idx) => idx !== i));
  const add = (t: typeof templates[number]) => {
    setAdding(false);
    onChange([...assertions, t.build()]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {assertions.map((a, i) => (
        <div key={i} className="flex items-start gap-1.5 group">
          <div className="flex-1 min-w-0">
            <AssertionRow assertion={a} onChange={(next) => update(i, next)} />
          </div>
          <button
            onClick={() => remove(i)}
            title="Remove assertion"
            className="shrink-0 mt-0.5 p-0.5 rounded text-slate-600 hover:text-red-400 hover:bg-red-950/40 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <XIcon size={12} />
          </button>
        </div>
      ))}

      {adding ? (
        <div className="flex flex-col gap-1 border border-indigo-700/50 rounded p-1.5 bg-indigo-950/20">
          <div className="text-[10px] text-indigo-300 uppercase tracking-wider px-1">Pick assertion kind</div>
          {templates.map((t) => (
            <button
              key={t.label}
              onClick={() => add(t)}
              className="text-left text-[11px] px-2 py-1 rounded text-slate-200 hover:bg-indigo-700/50 transition-colors"
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => setAdding(false)}
            className="text-[10px] px-2 py-0.5 rounded text-slate-500 hover:text-slate-300 self-end mt-0.5"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="self-start flex items-center gap-1 text-[10px] px-2 py-1 rounded text-slate-400 hover:text-indigo-300 hover:bg-indigo-950/40 transition-colors"
        >
          <Plus size={10} /> Add assertion
        </button>
      )}
    </div>
  );
}

// ─── Per-kind row editors ────────────────────────────────────────────────────

function AssertionRow({ assertion, onChange }: { assertion: Assertion; onChange: (next: Assertion) => void }) {
  const a = assertion;
  switch (a.kind) {
    case "status":
      return (
        <Row label="Status =">
          <NumberInput value={a.equals} onChange={(v) => onChange({ ...a, equals: v })} width="w-16" />
        </Row>
      );

    case "status_in":
      return (
        <Row label="Status in">
          <TextInput
            value={a.values.join(", ")}
            onChange={(v) => onChange({ ...a, values: v.split(/[,\s]+/).map(Number).filter((n) => !Number.isNaN(n)) })}
            placeholder="200, 201, 204"
            mono
          />
        </Row>
      );

    case "header":
      return (
        <Row label="Header">
          <TextInput
            value={a.name}
            onChange={(v) => onChange({ ...a, name: v })}
            placeholder="Content-Type"
            mono
            width="w-32"
          />
          <select
            value={a.equals !== undefined ? "equals" : a.matches !== undefined ? "matches" : "present"}
            onChange={(e) => {
              const mode = e.target.value as "equals" | "matches" | "present";
              if (mode === "equals")  onChange({ kind: "header", name: a.name, equals: a.equals ?? a.matches ?? "" });
              if (mode === "matches") onChange({ kind: "header", name: a.name, matches: a.matches ?? a.equals ?? "" });
              if (mode === "present") onChange({ kind: "header", name: a.name });
            }}
            className="bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
          >
            <option value="equals">equals</option>
            <option value="matches">matches</option>
            <option value="present">present</option>
          </select>
          {a.equals !== undefined && (
            <TextInput value={a.equals} onChange={(v) => onChange({ ...a, equals: v })} placeholder="value" mono />
          )}
          {a.matches !== undefined && (
            <TextInput value={a.matches} onChange={(v) => onChange({ ...a, matches: v })} placeholder="^regex$" mono />
          )}
        </Row>
      );

    case "body_contains":
      return (
        <Row label="Body contains">
          <TextInput value={a.text} onChange={(v) => onChange({ ...a, text: v })} placeholder='"tags":[]' mono />
        </Row>
      );

    case "body_matches":
      return (
        <Row label="Body matches">
          <TextInput value={a.pattern} onChange={(v) => onChange({ ...a, pattern: v })} placeholder="^DEBUG.*ready$" mono />
        </Row>
      );

    case "json_path": {
      const op = a.equals !== undefined ? "equals" : a.matches !== undefined ? "matches" : a.exists !== undefined ? "exists" : "present";
      return (
        <Row label="JSON path">
          <TextInput value={a.path} onChange={(v) => onChange({ ...a, path: v })} placeholder="$.id" mono width="w-28" />
          <select
            value={op}
            onChange={(e) => {
              const m = e.target.value as "equals" | "matches" | "exists" | "present";
              const base = { kind: "json_path" as const, path: a.path };
              if (m === "equals")  onChange({ ...base, equals: "" });
              if (m === "matches") onChange({ ...base, matches: "" });
              if (m === "exists")  onChange({ ...base, exists: true });
              if (m === "present") onChange({ ...base });
            }}
            className="bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
          >
            <option value="equals">equals</option>
            <option value="matches">matches</option>
            <option value="exists">exists</option>
            <option value="present">present</option>
          </select>
          {a.equals !== undefined && (
            <TextInput value={String(a.equals)} onChange={(v) => onChange({ ...a, equals: coerceValue(v) })} placeholder="value" mono />
          )}
          {a.matches !== undefined && (
            <TextInput value={a.matches} onChange={(v) => onChange({ ...a, matches: v })} placeholder="regex" mono />
          )}
          {a.exists !== undefined && (
            <select
              value={a.exists ? "true" : "false"}
              onChange={(e) => onChange({ ...a, exists: e.target.value === "true" })}
              className="bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
            >
              <option value="true">present</option>
              <option value="false">absent</option>
            </select>
          )}
        </Row>
      );
    }

    case "response_time_ms":
      return (
        <Row label="Response time <">
          <NumberInput value={a.lt} onChange={(v) => onChange({ ...a, lt: v })} width="w-20" />
          <span className="text-[10px] text-slate-500 self-center">ms</span>
        </Row>
      );

    case "exit_code":
      return (
        <Row label="Exit code =">
          <NumberInput value={a.equals} onChange={(v) => onChange({ ...a, equals: v })} width="w-16" />
        </Row>
      );
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[11px] bg-slate-900 border border-slate-700 rounded px-2 py-1">
      <span className="text-[10px] text-slate-500 uppercase tracking-wider shrink-0">{label}</span>
      {children}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, mono, width }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  width?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] text-slate-100 focus:outline-none placeholder:text-slate-600 ${mono ? "font-mono" : ""} ${width ?? "flex-1 min-w-0"}`}
    />
  );
}

function NumberInput({ value, onChange, width }: { value: number; onChange: (v: number) => void; width?: string }) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none text-center ${width ?? "w-16"}`}
    />
  );
}

/**
 * Try to coerce a string user input into a number / boolean / null when it
 * looks like one. Falls back to the original string. Used by the JSON path
 * equals editor so `42` is compared as a number, not the string "42".
 */
function coerceValue(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  // JSON literal (object/array)
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  return s;
}
