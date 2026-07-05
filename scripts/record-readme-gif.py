#!/usr/bin/env python3
# Record a short screencast of the agent-trail demo mode → assemble into GIF.
# Requires: playwright (chromium installed), ffmpeg on PATH.
#
# Usage:
#   1. Start the app in demo mode: bun packages/cli/src/index.ts --demo --no-open
#   2. Run: python3 scripts/record-readme-gif.py
#   3. Output: docs/agent-trail-demo.gif

import os, sys, time, subprocess, pathlib
from playwright.sync_api import sync_playwright

ROOT   = pathlib.Path(__file__).resolve().parent.parent
FRAMES = ROOT / ".tmp-frames"
OUT    = ROOT / "docs" / "agent-trail-demo.gif"

URL     = os.environ.get("AGENT_TRAIL_URL", "http://localhost:3002/?demo=1")
WIDTH   = int(os.environ.get("GIF_WIDTH",  "1200"))
HEIGHT  = int(os.environ.get("GIF_HEIGHT", "680"))
SECONDS = int(os.environ.get("GIF_SECONDS", "14"))
FPS     = int(os.environ.get("GIF_FPS",     "10"))

def main() -> int:
    FRAMES.mkdir(exist_ok=True)
    for f in FRAMES.glob("*.png"): f.unlink()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=2)
        page = ctx.new_page()
        print(f"→ opening {URL}")
        page.goto(URL, wait_until="networkidle", timeout=30_000)
        # Let the demo replay + Scout animations get past the first frame.
        page.wait_for_selector('[data-testid="scout-mascot"]', timeout=10_000)
        # Extra beat so the demo doesn't screenshot the empty initial state.
        page.wait_for_timeout(1200)

        total_frames = SECONDS * FPS
        interval_ms = int(1000 / FPS)
        print(f"→ capturing {total_frames} frames @ {FPS}fps")
        start = time.time()
        for i in range(total_frames):
            path = FRAMES / f"f-{i:04d}.png"
            page.screenshot(path=str(path), full_page=False)
            elapsed = (time.time() - start) * 1000
            expected = (i + 1) * interval_ms
            drift = expected - elapsed
            if drift > 0: page.wait_for_timeout(int(drift))
        print(f"→ captured in {time.time() - start:.1f}s")
        browser.close()

    OUT.parent.mkdir(exist_ok=True)
    # High-quality palette pipeline: extract a palette, then use it. Produces
    # a much crisper GIF than ffmpeg's default.
    palette = FRAMES / "palette.png"
    filters = f"fps={FPS},scale={WIDTH}:-1:flags=lanczos"
    print("→ ffmpeg pass 1 (palette)")
    subprocess.run([
        "ffmpeg", "-y", "-framerate", str(FPS),
        "-i", str(FRAMES / "f-%04d.png"),
        "-vf", f"{filters},palettegen=stats_mode=diff",
        str(palette),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print("→ ffmpeg pass 2 (encode)")
    subprocess.run([
        "ffmpeg", "-y", "-framerate", str(FPS),
        "-i", str(FRAMES / "f-%04d.png"),
        "-i", str(palette),
        "-lavfi", f"{filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5",
        str(OUT),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    size = OUT.stat().st_size / 1024
    print(f"✓ wrote {OUT.relative_to(ROOT)} ({size:.0f} KB)")
    # Clean intermediates.
    for f in FRAMES.glob("*.png"): f.unlink()
    FRAMES.rmdir()
    return 0

if __name__ == "__main__":
    sys.exit(main())
