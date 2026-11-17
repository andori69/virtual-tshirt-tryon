# Setup

Tested on: macOS 27.0.1, Apple M1 Pro, 16 GB RAM, Python 3.11.15 (Homebrew), Node 26.12 and npm 11.20.

## 1. Backend

Use Python **3.11**. On this machine, Python 3.13 and 3.15 are newer than the tested `onnxruntime` and `rembg` stack.

```bash
cd backend
/opt/homebrew/bin/python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # optional; defaults work without it
```

On first use, rembg downloads its background-removal model (`u2net`, 176 MB) to `~/.rembg/models/`. That needs internet access once. After that, everything runs offline.

### First owner account

There is no sign-up page. Create owners from the terminal:

```bash
.venv/bin/python -m app.cli create-owner owner
```

It prompts for a password (at least 10 characters). Running it again with the same username resets that password. For scripts, pass `--password-stdin`.

### Sample data (optional)

```bash
.venv/bin/python -m app.cli seed-samples
```

This adds two published products named `SAMPLE – …`. Their photos are drawn T-shirts that still go through the real background-removal pipeline. Delete them from the owner dashboard once you add real stock.

### Run

```bash
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

| Data | Location |
|---|---|
| Database | `backend/data/fitting_room.db` (SQLite) |
| Uploaded originals | `backend/assets/original/` |
| Processed garments | `backend/assets/processed/` |
| Masks | `backend/assets/masks/` |
| Raw cut-outs | `backend/assets/cutouts/` |
| Thumbnails | `backend/assets/thumbs/` |

Only `processed/` and `thumbs/` are publicly served. Originals go through an owner-only route.

## 2. Frontend

```bash
cd frontend
npm install
npm run fetch-models     # copies MediaPipe WASM and downloads pose + segmentation models (~10 MB) into public/mediapipe
npm run dev              # http://127.0.0.1:5173, proxies /api and /assets to :8000
```

Open http://127.0.0.1:5173/ for the kiosk and http://127.0.0.1:5173/owner for the owner dashboard.

Browsers only allow camera access on `localhost`/`127.0.0.1` or HTTPS. If the kiosk is a different machine than the server, serve over HTTPS and set `VFR_COOKIE_SECURE=true`.

For a kiosk, run the browser full screen, for example Chrome with `--kiosk http://127.0.0.1:5173/`.

## 3. Camera setup

- The kiosk asks for camera permission on first load. If it was denied, re-enable it in the browser's site settings, then press **Retry camera**.
- macOS also needs the browser allowed under **System Settings → Privacy & Security → Camera**.
- The kiosk's resolution and frame rate are set in **Owner → Settings → Kiosk camera**. The default is 1280×720 at 30 fps.
- With more than one camera, pick one in **Owner → Camera Calibration**. Kiosk and calibration share the remembered camera in that browser.
- Mount the camera at roughly chest height, level, about 2 m from where customers stand. The whole upper body and hips must be in view.
- Calibrate afterwards; see [CALIBRATION.md](CALIBRATION.md).
- Press **Alt+D** on the kiosk to show resolution, FPS, detection latency and the GPU/CPU delegate.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Body tracking could not start" | Run `npm run fetch-models` and check `frontend/public/mediapipe/` has the `.task` and `.tflite` files and `wasm/`. Reload. |
| "Camera permission was denied" | Allow the camera for the site in the browser, and for the browser in macOS Privacy settings. |
| "The camera is busy" | Quit other apps using the camera (Zoom, FaceTime, Photo Booth). |
| "Cannot reach the server" | The backend isn't running on :8000. |
| `pip install` fails on onnxruntime | You're not on Python 3.11. Recreate the venv with `python3.11`. |
| Processing says it could not separate the shirt | Retake the photo on a plain background with a different color from the shirt. |
| Size estimate says "not calibrated" | Calibrate in Owner → Camera Calibration. |
| Overlay sits too high or low on everyone | Adjust the anchors on that product. `SHOULDER_LIFT` in `frontend/src/components/FittingStage.tsx` is a global offset. |
| Forgot owner password | `.venv/bin/python -m app.cli create-owner <username>` resets it. |
