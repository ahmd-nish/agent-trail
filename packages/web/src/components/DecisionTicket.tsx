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
      <div className="px-3 py-2 rounded" style={{ background: "var(--bg-panel)", border: "1px solid var(--line)" }}>
        <p style={{ fontSize: 10, color: "var(--fg-faded)", marginBottom: 3 }}>decision answered</p>
        <p style={{ fontSize: 11, color: "var(--fg-dim)", fontStyle: "italic" }}>{ticket.question}</p>
        <p style={{ fontSize: 11, color: "var(--green)", marginTop: 4 }}>→ {ticket.answer}</p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 px-3 py-3 rounded ask-human-glow"
      style={{ background: "var(--amber-dim)", border: "1px solid rgba(255,180,84,0.35)" }}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full col-active-dot" style={{ background: "var(--amber)", flexShrink: 0 }} />
        <span style={{ fontSize: 10, color: "var(--amber)", fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase" as const }}>awaiting your input</span>
      </div>

      <p style={{ fontSize: 11, color: "var(--fg)", lineHeight: 1.5 }}>{ticket.question}</p>

      {ticket.context && (
        <p style={{ fontSize: 10, color: "var(--fg-dim)", lineHeight: 1.6 }}>{ticket.context}</p>
      )}

      <div className="flex gap-2 mt-0.5">
        <input
          autoFocus
          placeholder="your answer…"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && submit()}
          className="flex-1 focus:outline-none"
          style={{
            background: "var(--bg)",
            border: "1px solid rgba(255,180,84,0.4)",
            color: "var(--fg)",
            fontFamily: "inherit",
            fontSize: 11,
            borderRadius: 2,
            padding: "4px 8px",
          }}
        />
        <button
          onClick={submit}
          disabled={submitting || !answer.trim()}
          className="claw-btn amber"
          style={{ fontSize: 10, opacity: submitting || !answer.trim() ? 0.4 : 1 }}
        >
          {submitting ? "…" : "answer"}
        </button>
      </div>
    </div>
  );
}
