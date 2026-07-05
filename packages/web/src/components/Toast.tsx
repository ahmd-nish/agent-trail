import { useState, useEffect, useCallback, createContext, useContext, useRef } from "react";

export interface ToastMessage {
  id: string;
  emoji: string;
  title: string;
  sub?: string;
}

interface ToastCtx {
  push: (msg: Omit<ToastMessage, "id">) => void;
}

const Ctx = createContext<ToastCtx>({ push: () => {} });

export function useToast() { return useContext(Ctx); }

let _push: ((msg: Omit<ToastMessage, "id">) => void) | null = null;

/** Push a toast from outside React (e.g. useTaskExecution). */
export function pushToast(msg: Omit<ToastMessage, "id">) { _push?.(msg); }

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const idRef = useRef(0);

  const push = useCallback((msg: Omit<ToastMessage, "id">) => {
    const id = String(++idRef.current);
    setToasts((ts) => [...ts, { ...msg, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3500);
  }, []);

  // Expose globally for imperative use
  useEffect(() => { _push = push; return () => { _push = null; }; }, [push]);

  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 items-end pointer-events-none">
        {toasts.map((t) => <ToastCard key={t.id} toast={t} />)}
      </div>
    </Ctx.Provider>
  );
}

function ToastCard({ toast }: { toast: ToastMessage }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="transition-all duration-300"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(8px) scale(0.96)",
        background: "var(--bg-pane)",
        border: "1px solid var(--green-line)",
        borderRadius: 4,
        padding: "8px 14px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxShadow: "0 0 20px rgba(94,232,157,0.15)",
        fontFamily: "inherit",
        minWidth: 180,
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1 }}>{toast.emoji}</span>
      <div>
        <p style={{ fontSize: 11, color: "var(--green)", fontWeight: 500 }}>{toast.title}</p>
        {toast.sub && <p style={{ fontSize: 10, color: "var(--fg-faded)", marginTop: 1 }}>{toast.sub}</p>}
      </div>
    </div>
  );
}
