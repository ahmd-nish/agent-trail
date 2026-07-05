import { Rocket, MessageSquare, PartyPopper, Skull, Hand, FlaskConical, Siren, Check } from "lucide-react";
import type { FeedItem } from "./types.ts";
import { ToolCallCard } from "./ToolCallCard.tsx";
import { TypewriterText } from "./TypewriterText.tsx";

interface Props {
  item: FeedItem;
  animateText?: boolean;
  typewriterCps?: number;
}

export function EventCard({ item, animateText = false, typewriterCps = 35 }: Props) {
  if (item.kind === "connected") {
    return (
      <p className="log-line-enter flex items-center gap-2 text-slate-500 text-[11px]">
        <Rocket size={12} className="shrink-0 text-slate-400" aria-hidden="true" />
        <span>Connected — session <span className="font-mono text-slate-400">{item.executionId.slice(0, 8)}</span></span>
      </p>
    );
  }

  if (item.kind === "tool") {
    return <ToolCallCard item={item} />;
  }

  if (item.kind === "text") {
    return (
      <div className="log-line-enter flex items-start gap-2 mt-0.5">
        <MessageSquare size={12} className="shrink-0 text-slate-500 mt-0.5" aria-hidden="true" />
        <TypewriterText
          text={item.text}
          animate={animateText}
          cps={typewriterCps}
          className="text-slate-300 whitespace-pre-wrap leading-relaxed flex-1 italic text-[12px]"
        />
      </div>
    );
  }

  if (item.kind === "complete") {
    const ok = item.status === "completed";
    return (
      <div
        role="status"
        className={`log-line-enter font-semibold mt-2 px-3 py-2 rounded-lg border flex items-center gap-2 text-[12px] ${
          ok
            ? "border-emerald-700/50 bg-emerald-950/40 text-emerald-300"
            : "border-red-700/50 bg-red-950/40 text-red-300"
        }`}
      >
        {ok
          ? <PartyPopper size={14} className="shrink-0" aria-hidden="true" />
          : <Skull size={14} className="shrink-0" aria-hidden="true" />}
        {ok ? "Task complete — all done!" : "Execution failed"}
      </div>
    );
  }

  if (item.kind === "awaiting") {
    return (
      <div
        role="status"
        className="log-line-enter font-semibold mt-2 px-3 py-2 rounded-lg border border-amber-700/50 bg-amber-950/40 text-amber-300 flex items-center gap-2 text-[12px]"
      >
        <Hand size={14} className="shrink-0" aria-hidden="true" />
        Claude needs a human decision — scroll down to answer.
      </div>
    );
  }

  if (item.kind === "test") {
    return (
      <div
        className={`log-line-enter font-semibold px-3 py-1.5 rounded flex items-center gap-2 text-[12px] ${
          item.passed ? "bg-emerald-950/40 text-emerald-300" : "bg-red-950/40 text-red-300"
        }`}
      >
        {item.passed
          ? <FlaskConical size={13} className="shrink-0" aria-hidden="true" />
          : <Siren size={13} className="shrink-0" aria-hidden="true" />}
        Tests {item.passed ? "passed" : `failed (exit ${item.exitCode})`}
      </div>
    );
  }

  return null;
}
