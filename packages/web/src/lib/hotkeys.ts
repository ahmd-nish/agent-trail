/** Global keyboard shortcut manager. Skips when focus is inside an input/textarea. */

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable;
}

export function registerHotkeys(map: HotkeyMap): () => void {
  const handler = (e: KeyboardEvent) => {
    // Don't intercept modifier-key combos (those are handled elsewhere).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping()) return;

    const key = e.key;
    if (map[key]) {
      e.preventDefault();
      map[key]!(e);
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
