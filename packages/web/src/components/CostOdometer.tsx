import { useEffect, useRef, useState } from "react";
import { DollarSign } from "lucide-react";
import { api } from "../lib/api.ts";

interface Props {
  boardId: string | null;
  /** Poll interval — cheap: aggregates from an existing metrics endpoint. */
  intervalMs?: number;
}

/**
 * Cost odometer — PRD 1.15. Aggregates board-wide input+output tokens and
 * prices them at Claude Sonnet 4.6 published rates as a "close enough" figure.
 * Ticks with a brief animation when the number changes.
 *
 * Prices in USD per 1M tokens (as of 2026-07-01). Rounded so a single number
 * can cover the mix; the point is a visible cost dial, not an audit.
 */
const PRICE_PER_MTOK_IN  = 3.00;  // Sonnet input
const PRICE_PER_MTOK_OUT = 15.00; // Sonnet output

function priceUsd(inTok: number, outTok: number): number {
  return (inTok / 1_000_000) * PRICE_PER_MTOK_IN + (outTok / 1_000_000) * PRICE_PER_MTOK_OUT;
}

function fmtUsd(v: number): string {
  if (v === 0) return "$0.00";
  if (v < 0.01) return "<$0.01";
  return `$${v.toFixed(2)}`;
}

export function CostOdometer({ boardId, intervalMs = 3000 }: Props) {
  const [cents, setCents] = useState<number>(0);
  const [tokens, setTokens] = useState<{ i: number; o: number }>({ i: 0, o: 0 });
  const [ticking, setTicking] = useState(false);
  const prev = useRef(0);

  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;

    async function refresh() {
      if (!boardId) return;
      try {
        const rows = await api.metrics.board(boardId);
        if (cancelled) return;
        const i = rows.reduce((s, r) => s + (r.total_input_tokens ?? 0), 0);
        const o = rows.reduce((s, r) => s + (r.total_output_tokens ?? 0), 0);
        const usd = priceUsd(i, o);
        const nextCents = Math.round(usd * 100);
        setTokens({ i, o });
        setCents(nextCents);
        if (nextCents !== prev.current) {
          setTicking(true);
          setTimeout(() => setTicking(false), 250);
        }
        prev.current = nextCents;
      } catch { /* transient — ignore */ }
    }
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [boardId, intervalMs]);

  if (!boardId) return null;
  const usd = cents / 100;
  const totalTokens = tokens.i + tokens.o;
  if (totalTokens === 0) return null;

  return (
    <span
      className="claw-chip"
      title={`${tokens.i.toLocaleString()} in · ${tokens.o.toLocaleString()} out (Sonnet pricing estimate)`}
      style={{ gap: 4, color: "var(--fg-dim)" }}
    >
      <DollarSign size={9} />
      <span className={ticking ? "odometer-tick" : undefined}>{fmtUsd(usd)}</span>
    </span>
  );
}
