import { useEffect, useRef } from "react";
import type { BeatMood } from "../../lib/beat-compiler.ts";

// PRD_FEED_EXPERIENCE §3b — the digital rain canvas that sits BEHIND the
// Matrix theme feed. Density and speed follow live activity (mood); color
// shifts by mood (green → amber when stuck → gold on verify).
//
// Perf discipline: 30fps cap, paused when tab hidden or canvas is off-screen
// via the passed-in `active` prop. No dependency, pure canvas 2D.

interface Props {
  mood: BeatMood;
  active: boolean;
}

const GLYPHS = "ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789><=+";

const MOOD_COLOR: Record<BeatMood, string> = {
  investigating: "#3fbf7f",
  building:      "#3fbf7f",
  testing:       "#8b5cf6",
  stuck:         "#f59e0b",
  triumphant:    "#facc15",
  neutral:       "#5eb87f",
};

// Densities feel right at these values on a 900px feed — tuned empirically.
const MOOD_DENSITY: Record<BeatMood, number> = {
  investigating: 0.9,
  building:      0.85,
  testing:       1.1,
  stuck:         0.7,
  triumphant:    1.3,
  neutral:       0.75,
};

export function MatrixRain({ mood, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const dropsRef = useRef<number[]>([]);
  const lastTsRef = useRef<number>(0);
  const moodRef = useRef<BeatMood>(mood);

  useEffect(() => { moodRef.current = mood; }, [mood]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const CELL = 14;
    let cols = 0;

    function resize() {
      if (!canvas) return;
      const parent = canvas.parentElement;
      const w = parent?.clientWidth ?? window.innerWidth;
      const h = parent?.clientHeight ?? window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.floor(w / CELL);
      // (Re-)seed drop y-positions randomly so we don't get a stripe.
      const drops: number[] = new Array(cols);
      for (let i = 0; i < cols; i++) drops[i] = Math.floor(Math.random() * (h / CELL)) * -1;
      dropsRef.current = drops;
    }
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const targetFps = 30;
    const frameMs = 1000 / targetFps;
    let running = true;

    const tick = (now: number) => {
      if (!running) return;
      if (now - lastTsRef.current >= frameMs) {
        lastTsRef.current = now;
        step();
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    function step() {
      const c = canvas;
      if (!c || !ctx) return;
      const w = c.width  / (window.devicePixelRatio || 1);
      const h = c.height / (window.devicePixelRatio || 1);
      // Trail: paint semi-transparent black over the whole canvas so old
      // glyphs fade out over ~10 frames.
      ctx.fillStyle = "rgba(0,0,0,0.14)";
      ctx.fillRect(0, 0, w, h);

      const drops = dropsRef.current;
      const color = MOOD_COLOR[moodRef.current];
      const density = MOOD_DENSITY[moodRef.current];
      ctx.font = "12px 'Fira Code', ui-monospace, monospace";

      for (let i = 0; i < drops.length; i++) {
        const drop = drops[i];
        if (drop === undefined) continue;
        // Occasionally skip a column to break the perfect grid.
        if (Math.random() > density) { drops[i] = drop + 1; continue; }
        const y = drop * CELL;
        const g = GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? "0";
        // Head of the drop is bright + color, tail dimmer.
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.fillText(g, i * CELL, y);
        ctx.globalAlpha = 1;

        if (y > h && Math.random() > 0.98) {
          drops[i] = 0;
        } else {
          drops[i] = drop + 1;
        }
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    // Pause when tab hidden — perf budget from spec.
    const onVis = () => { running = !document.hidden; if (running) rafRef.current = requestAnimationFrame(tick); };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none", opacity: 0.55 }}
    />
  );
}
