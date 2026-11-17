# Usage (from backend/): .venv/bin/python scripts/make_cases.py <photo.jpg> <out.y4m> <mode> [seconds]
# Builds a 1280x720 fake-webcam clip (Y4M, for Chromium's --use-file-for-fake-video-capture) from one person photo:
#   still   - padded to 16:9 so the head is never cropped
#   window  - strong cool daylight from the image left, deep shadow on the right, clipped highlights
#   dim     - a third of the light, warm bulbs, sensor noise
#   closer  - person scaled up until the hips leave the frame
#   farther - person small in the frame (about 3.5 m away)
#   sway    - side-to-side movement (secondary motion / jitter check)
#   walk    - walks toward the camera and back (scale 0.55 -> 1.25 -> 0.55)
#   tilt    - whole person leaning 8 degrees (shoulders tilted)
import subprocess
import sys

import numpy as np
from PIL import Image

W, H, FPS = 1280, 720, 15


def frame(person: Image.Image, scale: float, dx: float = 0, dy: float = 0) -> Image.Image:
    """Person photo scaled to `scale` x frame height, centred (+dx, dy px), on its own edge colour."""
    bg = person.getpixel((4, 4))
    out = Image.new("RGB", (W, H), bg)
    h = int(H * scale)
    p = person.resize((int(person.width * h / person.height), h), Image.LANCZOS)
    out.paste(p, (int((W - p.width) / 2 + dx), int(dy)))
    return out


def relight(img: Image.Image, mode: str, rng: np.random.Generator) -> Image.Image:
    a = np.asarray(img).astype(np.float32) / 255
    if mode == "window":
        ramp = np.linspace(1.7, 0.45, W)[None, :, None]           # light from the image left
        a = a * ramp * np.array([0.92, 1.0, 1.12])                # cool daylight
    elif mode == "dim":
        a = a * 0.33 * np.array([1.12, 1.0, 0.8])                 # warm, low light
        a = a + rng.normal(0, 0.025, a.shape)                     # sensor noise
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))


def main() -> None:
    src, dst, mode = sys.argv[1], sys.argv[2], sys.argv[3]
    seconds = float(sys.argv[4]) if len(sys.argv) > 4 else 6
    person = Image.open(src).convert("RGB")
    rng = np.random.default_rng(0)
    n = int(seconds * FPS)
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                           "-r", str(FPS), "-i", "-", "-pix_fmt", "yuv420p", dst], stdin=subprocess.PIPE)
    for i in range(n):
        t = i / FPS
        if mode == "closer":
            img = frame(person, 1.55, dy=-0.12 * H)
        elif mode == "farther":
            img = frame(person, 0.62, dy=0.25 * H)
        elif mode == "sway":
            img = frame(person, 1.0, dx=90 * np.sin(2 * np.pi * t / 2.0))
        elif mode == "walk":
            s = 0.55 + 0.7 * (0.5 - 0.5 * np.cos(2 * np.pi * t / seconds))
            img = frame(person, s, dy=(1 - s) * 0.45 * H - max(0, s - 1) * 0.3 * H)
        elif mode == "tilt":
            img = frame(person, 1.0).rotate(8, resample=Image.BICUBIC, fillcolor=person.getpixel((4, 4)))
        else:
            img = frame(person, 1.0)
        if mode in ("window", "dim"):
            img = relight(img, mode, rng)
        ff.stdin.write(img.tobytes())
    ff.stdin.close()
    ff.wait()


if __name__ == "__main__":
    main()
