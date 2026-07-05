const SEQUENCE = [
  "ArrowUp","ArrowUp","ArrowDown","ArrowDown",
  "ArrowLeft","ArrowRight","ArrowLeft","ArrowRight",
  "b","a",
];

let buffer: string[] = [];
let partyTimeout: ReturnType<typeof setTimeout> | null = null;

function activate() {
  document.body.classList.add("neon-party");
  if (partyTimeout) clearTimeout(partyTimeout);
  partyTimeout = setTimeout(() => {
    document.body.classList.remove("neon-party");
    partyTimeout = null;
  }, 5000);
}

export function initKonami() {
  window.addEventListener("keydown", (e) => {
    // Don't fire when typing in inputs
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    buffer.push(e.key);
    if (buffer.length > SEQUENCE.length) buffer.shift();

    if (buffer.length === SEQUENCE.length && buffer.every((k, i) => k === SEQUENCE[i])) {
      buffer = [];
      activate();
    }
  });
}
