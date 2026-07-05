import { useState } from "react";
import type { Task, TaskStatus } from "../../../../core/src/types/index.ts";
import type { ExecutionRow, ArtifactRow } from "../../lib/api.ts";
import {
  SectionLabel,
  MetricChip,
  DescriptionBullets,
  DiffViewer,
  fmtDuration,
  fmtTokens,
} from "./atoms.tsx";
import { TestRunner } from "./TestRunner.tsx";

interface Props {
  task: Task;
  executions: ExecutionRow[];
  artifacts: ArtifactRow[];
  successCriteria: string[];
  onStatusChange: (s: TaskStatus) => void;
  onRerun: (fixNote: string) => Promise<void>;
}

export function ReviewModeBody({ task, executions, artifacts, successCriteria, onStatusChange, onRerun }: Props) {
  const totalDuration = executions.reduce((s, e) => s + (e.duration_ms ?? 0), 0);
  const totalIn = executions.reduce((s, e) => s + (e.total_input_tokens ?? 0), 0);
  const totalOut = executions.reduce((s, e) => s + (e.total_output_tokens ?? 0), 0);
  const latestExec = executions[0] ?? null;

  const diffArtifact = artifacts.find((a) => a.kind === "git_diff");
  const fileList = artifacts.find((a) => a.kind === "file_list");
  const prArtifact = artifacts.find((a) => a.kind === "pr_url");

  const [fixNote, setFixNote] = useState("");
  const [fixRunning, setFixRunning] = useState(false);
  const [showFixForm, setShowFixForm] = useState(false);

  async function handleFix() {
    if (!fixNote.trim()) return;
    setFixRunning(true);
    try { await onRerun(fixNote.trim()); }
    finally { setFixRunning(false); setFixNote(""); setShowFixForm(false); }
  }

  return (
    <div className="flex-1 overflow-hidden min-h-0 flex">

      {/* LEFT — cost + meta + fix + approve */}
      <div className="w-60 shrink-0 border-r border-slate-700/50 overflow-y-auto flex flex-col gap-5 p-5">

        <div className="flex flex-col gap-2">
          <SectionLabel>Execution cost</SectionLabel>
          <MetricChip label="Time" value={fmtDuration(totalDuration)} color="text-slate-200" />
          <div className="grid grid-cols-2 gap-2">
            <MetricChip label="In" value={fmtTokens(totalIn)} color="text-blue-300" />
            <MetricChip label="Out" value={fmtTokens(totalOut)} color="text-violet-300" />
          </div>
          {executions.length > 1 && <p className="text-[10px] text-slate-600">{executions.length} runs total</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <SectionLabel>Details</SectionLabel>
          {task.component && <div className="flex gap-2"><span className="text-[10px] text-slate-500 w-16 shrink-0">Component</span><span className="text-xs text-slate-300 font-mono truncate">{task.component}</span></div>}
          <div className="flex gap-2"><span className="text-[10px] text-slate-500 w-16 shrink-0">Assignee</span><span className="text-xs text-slate-300">{task.assignee}</span></div>
          {task.model && <div className="flex gap-2"><span className="text-[10px] text-slate-500 w-16 shrink-0">Model</span><span className="text-xs text-slate-300 truncate">{task.model}</span></div>}
        </div>

        {latestExec?.error_message && (
          <div className="bg-red-950/40 border border-red-800/40 rounded-lg p-3">
            <SectionLabel>Error</SectionLabel>
            <pre className="text-xs text-red-300 whitespace-pre-wrap font-mono leading-relaxed">{latestExec.error_message}</pre>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <SectionLabel>Report an issue</SectionLabel>
          {!showFixForm ? (
            <button onClick={() => setShowFixForm(true)} className="text-xs text-slate-500 hover:text-slate-300 text-left transition-colors">
              Something wrong? Fix & re-run →
            </button>
          ) : (
            <div className="flex flex-col gap-2 bg-slate-800/60 border border-slate-700/50 rounded-lg p-3">
              <textarea
                rows={3}
                value={fixNote}
                onChange={(e) => setFixNote(e.target.value)}
                placeholder="e.g. The retry logic doesn't handle timeout errors…"
                className="bg-slate-900 border border-slate-600 rounded px-2.5 py-2 text-xs text-slate-100 focus:outline-none focus:border-slate-400 resize-none placeholder:text-slate-600 w-full"
              />
              <div className="flex gap-2">
                <button onClick={handleFix} disabled={fixRunning || !fixNote.trim()} className="flex-1 text-xs px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-40 text-white transition-colors">
                  {fixRunning ? "Sending…" : "Fix & re-run"}
                </button>
                <button onClick={() => { setShowFixForm(false); setFixNote(""); }} className="text-xs px-2.5 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-auto pt-2">
          {task.status === "in_review" ? (
            <button onClick={() => onStatusChange("done")} className="text-sm px-4 py-2.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-medium transition-colors w-full">
              ✓ Approve & mark done
            </button>
          ) : (
            <div className="text-center text-xs text-emerald-500 font-medium py-2">✓ Completed</div>
          )}
        </div>
      </div>

      {/* RIGHT — what was built + test runner + artifacts */}
      <div className="flex-1 overflow-y-auto flex flex-col min-w-0">

        <div className="px-6 py-5 border-b border-slate-800">
          <SectionLabel>What was built</SectionLabel>
          <DescriptionBullets text={task.description} />
        </div>

        <div className="px-6 py-5 border-b border-slate-800">
          <SectionLabel>Test &amp; verify</SectionLabel>
          <TestRunner task={task} successCriteria={successCriteria} />
        </div>

        {prArtifact && (
          <div className="px-6 py-4 border-b border-slate-800">
            <SectionLabel>Pull request</SectionLabel>
            <a href={prArtifact.content} target="_blank" rel="noreferrer" className="text-sm text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
              {prArtifact.content}
            </a>
          </div>
        )}

        {fileList && (
          <div className="px-6 py-4 border-b border-slate-800">
            <SectionLabel>Changed files</SectionLabel>
            <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap leading-relaxed">{fileList.content}</pre>
          </div>
        )}

        {diffArtifact && (
          <div className="flex flex-col border-b border-slate-800">
            <div className="px-6 pt-4 pb-2 shrink-0"><SectionLabel>Git diff</SectionLabel></div>
            <div className="overflow-y-auto max-h-[480px] bg-slate-950/50">
              <DiffViewer content={diffArtifact.content} />
            </div>
          </div>
        )}

        {!diffArtifact && !fileList && !prArtifact && (
          <div className="flex items-center justify-center text-slate-600 gap-2 py-10">
            <p className="text-xs text-slate-700">Run the task to capture diff, files, and PR</p>
          </div>
        )}
      </div>
    </div>
  );
}
