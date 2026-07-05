import { useEffect, useRef } from "react";
import { setRunningSpinner, setBadge, clear } from "./favicon.ts";

interface Counts {
  running: number;
  awaitingHuman: number;
}

/** Updates the document title and favicon based on running/awaiting-human counts. */
export function useTabTitle({ running, awaitingHuman }: Counts) {
  const pulseRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseStateRef = useRef(false);

  useEffect(() => {
    if (pulseRef.current) {
      clearInterval(pulseRef.current);
      pulseRef.current = null;
    }

    if (awaitingHuman > 0) {
      const titles = [`(${awaitingHuman}) ⚠ agent-trail`, `agent-trail ⚠`];
      let idx = 0;
      document.title = titles[0]!;
      pulseRef.current = setInterval(() => {
        idx = (idx + 1) % 2;
        document.title = titles[idx]!;
        pulseStateRef.current = !pulseStateRef.current;
      }, 1500);
      setBadge(awaitingHuman, "#f59e0b").catch(() => undefined);
    } else if (running > 0) {
      document.title = `(${running}) agent-trail`;
      setRunningSpinner().catch(() => undefined);
    } else {
      document.title = "agent-trail";
      clear();
    }

    return () => {
      if (pulseRef.current) clearInterval(pulseRef.current);
    };
  }, [running, awaitingHuman]);
}
