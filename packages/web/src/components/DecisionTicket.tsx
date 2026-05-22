import { useState } from "react";
import { api } from "../lib/api.ts";

interface Ticket {
  id: string;
  task_id: string;
  execution_id: string;
  question: string;
  context: string | null;
  answer: string | null;
  answered_at: string | null;
  created_at: string;
}

interface Props {
  ticket: Ticket;
  onAnswered: (ticketId: string, answer: string) => void;
}

export function DecisionTicket({ ticket, onAnswered }: Props) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.decisions.answer(ticket.id, answer.trim());
      onAnswered(ticket.id, answer.trim());
    } finally {
      setSubmitting(false);
    }
  }

  if (ticket.answer !== null) {
    return (
      <div className="bg-slate-800 border border-slate-600 rounded-lg p-3">
        <p className="text-xs text-slate-400 mb-1">Decision answered</p>
        <p className="text-xs text-slate-300 italic">{ticket.question}</p>
        <p className="text-xs text-emerald-400 mt-1">→ {ticket.answer}</p>
      </div>
    );
  }

  return (
    <div className="bg-amber-950/40 border border-amber-700/50 rounded-lg p-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        <span className="text-xs font-semibold text-amber-400">Awaiting your input</span>
      </div>
      <p className="text-sm text-slate-100">{ticket.question}</p>
      {ticket.context && (
        <p className="text-xs text-slate-400 leading-relaxed">{ticket.context}</p>
      )}
      <div className="flex gap-2 mt-1">
        <input
          autoFocus
          placeholder="Your answer…"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && submit()}
          className="flex-1 bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
        />
        <button
          onClick={submit}
          disabled={submitting || !answer.trim()}
          className="text-sm px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-medium"
        >
          {submitting ? "…" : "Answer"}
        </button>
      </div>
    </div>
  );
}
