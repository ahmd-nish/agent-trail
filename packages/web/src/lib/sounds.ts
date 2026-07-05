/** Web Audio API synthesized sounds — no audio file dependencies. */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  // Resume if suspended (autoplay policy)
  if (ctx.state === "suspended") ctx.resume().catch(() => undefined);
  return ctx;
}

interface SoundPrefs {
  tickOnTool: boolean;
  ding: boolean;
  ask: boolean;
  volume: number; // 0–1
}

let prefs: SoundPrefs = {
  tickOnTool: false,
  ding: true,
  ask: true,
  volume: 0.5,
};

export function setEnabled(p: Partial<SoundPrefs>) {
  prefs = { ...prefs, ...p };
}

export function setVolume(v: number) {
  prefs = { ...prefs, volume: Math.max(0, Math.min(1, v)) };
}

function masterGain(c: AudioContext): GainNode {
  const g = c.createGain();
  g.gain.value = prefs.volume;
  g.connect(c.destination);
  return g;
}

function playNote(
  freq: number,
  startTime: number,
  duration: number,
  gainDb: number,
  type: OscillatorType = "sine",
): void {
  const c = getCtx();
  const osc = c.createOscillator();
  const gain = c.createGain();
  const master = masterGain(c);

  osc.type = type;
  osc.frequency.value = freq;

  const amplitude = Math.pow(10, gainDb / 20);
  gain.gain.setValueAtTime(amplitude, startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  gain.connect(master);

  osc.start(startTime);
  osc.stop(startTime + duration + 0.01);
}

/** Brief pluck at 1200 Hz — tool tick. Very subtle. */
export function click() {
  if (!prefs.tickOnTool) return;
  const c = getCtx();
  const t = c.currentTime;
  playNote(1200, t, 0.04, -30, "triangle");
}

/** Arpeggiated 3-note chord on task completion. */
export function complete(success: boolean) {
  if (!prefs.ding) return;
  const c = getCtx();
  const t = c.currentTime;
  if (success) {
    // Major arpeggio: C5–E5–G5
    playNote(523.25, t,        0.12, -18, "sine");
    playNote(659.25, t + 0.08, 0.12, -18, "sine");
    playNote(783.99, t + 0.16, 0.20, -18, "sine");
  } else {
    // Minor descending: G4–Eb4–C4
    playNote(392.00, t,        0.10, -20, "sine");
    playNote(311.13, t + 0.08, 0.10, -20, "sine");
    playNote(261.63, t + 0.16, 0.18, -20, "sine");
  }
}

/** Warm 2-note chime — ask_human prompt. */
export function ask() {
  if (!prefs.ask) return;
  const c = getCtx();
  const t = c.currentTime;
  // G4 then C5, lowpass-filtered for warmth
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1800;
  const master = masterGain(c);
  lp.connect(master);

  [392.0, 523.25].forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t + i * 0.22;
    gain.gain.setValueAtTime(Math.pow(10, -16 / 20), start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
    osc.connect(gain);
    gain.connect(lp);
    osc.start(start);
    osc.stop(start + 0.55);
  });
}

/** Call once on first user gesture to un-suspend the AudioContext. */
export function prime() {
  try { getCtx(); } catch { /* unsupported */ }
}
