/** Canvas-based favicon badge and running spinner. */

const FAVICON_SIZE = 32;

let originalHref: string | null = null;
let spinnerRafId: number | null = null;

function getLink(): HTMLLinkElement {
  let el = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (!el) {
    el = document.createElement("link");
    el.rel = "icon";
    document.head.appendChild(el);
  }
  return el;
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = FAVICON_SIZE;
  c.height = FAVICON_SIZE;
  return c;
}

function getOriginalHref(): string {
  if (!originalHref) {
    originalHref = getLink().href || "/favicon.ico";
  }
  return originalHref;
}

async function drawBase(ctx: CanvasRenderingContext2D): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      ctx.drawImage(img, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
      resolve();
    };
    img.onerror = () => resolve(); // continue even if base fails
    img.src = getOriginalHref();
  });
}

export function clear() {
  if (spinnerRafId !== null) {
    cancelAnimationFrame(spinnerRafId);
    spinnerRafId = null;
  }
  if (originalHref) {
    getLink().href = originalHref;
  }
}

export async function setBadge(count: number, color = "#ef4444") {
  if (spinnerRafId !== null) {
    cancelAnimationFrame(spinnerRafId);
    spinnerRafId = null;
  }
  const canvas = makeCanvas();
  const ctx = canvas.getContext("2d")!;
  await drawBase(ctx);

  const label = count > 99 ? "99+" : String(count);
  const r = FAVICON_SIZE * 0.38;
  const cx = FAVICON_SIZE - r - 1;
  const cy = r + 1;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.floor(r * 1.2)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, cy + 1);

  getLink().href = canvas.toDataURL("image/png");
}

export async function setRunningSpinner() {
  const canvas = makeCanvas();
  const ctx = canvas.getContext("2d")!;
  await drawBase(ctx);
  // Save the base image data once
  const base = ctx.getImageData(0, 0, FAVICON_SIZE, FAVICON_SIZE);

  let angle = 0;
  function frame() {
    ctx.putImageData(base, 0, 0);
    const cx = FAVICON_SIZE - 8;
    const cy = 8;
    const r = 5;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + Math.PI * 1.3);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2;
    ctx.stroke();

    getLink().href = canvas.toDataURL("image/png");
    angle = (angle + 0.12) % (Math.PI * 2);
    spinnerRafId = requestAnimationFrame(frame);
  }

  spinnerRafId = requestAnimationFrame(frame);
}
