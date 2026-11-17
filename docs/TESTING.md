# Testing

## Automated

```bash
cd backend && .venv/bin/python -m pytest -q               # 50 tests
cd frontend && npm test                                   # 45 tests (vitest + Testing Library)
cd frontend && VFR_E2E_PASSWORD='<owner password>' npm run e2e   # 3 Playwright tests; backend + vite must be running
```

First-time e2e setup: `npx playwright install chromium`.

**Backend (pytest).** Covers:
- auth: hashing, 401 on every owner route, logout invalidating the token, throttle, password change;
- product CRUD, archive, delete with file cleanup;
- size validation against configurable limits; inventory rows following sizes and colors;
- upload validation by content (text renamed `.png`, GIF, truncated PNG, empty, tiny, oversized);
- real rembg processing success, and failure on a blank image;
- rotate, crop, reset, reprocess, replace; anchor validation;
- publish rules; draft and sold-out products hidden from the catalog; stock counts not exposed; owner edits reaching the catalog;
- originals and masks not public; path traversal blocked;
- ArUco scale, no-marker and tilt errors; the calibration API;
- recommendation math: monotonic fits, preferred band, out-of-stock fallback, shoulder-only fallback, low confidence, resolution scaling, refusal without calibration;
- settings validation.

**Frontend (vitest).** Covers:
- the affine solver; the garment transform (centering, lift, size ordering, calibrated scale, tilt, 15% distortion clamp);
- landmark ordering and the null-on-invisible rule; the One Euro filter; chest-from-mask, including the arms-merged rejection; sample summary and clearing;
- the size picker disabling sold-out sizes; the fit panel; size-table validation; upload pre-check; API error parsing;
- the login error and success path; the protected-route redirect;
- the kiosk flow: catalog, default size, recommendation request, reset clearing the session. The camera stage is replaced by a labelled test double.

**End-to-end (Playwright, real backend, real rembg, Chromium's built-in fake camera).** Covers:
- redirect to login, and a wrong password being rejected;
- create a draft → sizes → color → invalid upload error → real upload processed → anchor nudge and confirm → stock with S sold out;
- the draft absent from the catalog → publish → the kiosk shows it with S disabled and the price;
- the kiosk camera stream live and MediaPipe loaded;
- a price edit reflected on the kiosk; End session clearing the selection;
- owner camera capture, retake, the preview modal with the tracker loaded, and calibration reporting "No ArUco marker found" on the fake feed.

The fake camera shows a synthetic test pattern, not a person. It proves the camera and model plumbing, not body tracking.

**Mesh and skinning (vitest, `src/vision/mesh.test.ts`).** Covers:
- armpit, collar and neck detection on the sample tee outline;
- sleeve and torso weights; the inverse-bilinear round trip; sleeves drawn last;
- garment centred on the body, with a lifted shoulder line;
- sleeves following the upper arms without moving the torso;
- yaw narrowing; hip tilt tilting the hem;
- cling widening only, never shrinking;
- size ordering and the clamp;
- silhouette widths; yaw from world landmarks.

**Visual check on a real person (opt-in).**

```bash
VFR_FAKE_VIDEO=/abs/path/person.y4m npx playwright test e2e/visual.spec.ts
```

Chromium plays the Y4M clip as its webcam. The spec selects a sample shirt, waits for real MediaPipe tracking, and saves `e2e/output/visual-M.png`, `visual-L.png` (after a size change) and `visual-flat.png` (Alt+R lighting off) for a human to review.

In the build session it ran on a still photo of a person (Wikimedia Commons, CC BY 4.0; used locally, not committed). That run found and fixed three problems:
- upper-arm occlusion cut holes at the shoulders;
- forearms behind the back cut holes in the stomach;
- the real shoulders stuck out past the garment.

Limits of that run: the photo was black and white, so white balance was not checked, and headless software WebGL ran at about 6 fps, which says nothing about real-GPU speed.

## Public dataset checks (stand-in until our own recordings exist)

The [FIT dataset](https://github.com/HarryWang355/FIT-VTO) (HF `Yuanhao-Harry-Wang/fitvto-100k`, **CC BY-NC-ND 4.0**: local testing only, never commit or ship it) has full-body person photos, flat-lay garment photos, and true body and garment measurements in cm. The images are synthetic renders retextured to look photographic, so they stand in for real people but don't replace M1–M11.

Data lives in `recordings/datasets/`, which is gitignored.

```bash
cd backend
.venv/bin/python scripts/fetch_fit_samples.py ../recordings/datasets/fitvto 30     # 30 samples spread over the eval split
.venv/bin/python -m scripts.eval_garments ../recordings/datasets/fitvto ../recordings/datasets/eval
cd ../frontend   # needs the dev stack running
VFR_DATASET="$PWD/../recordings/datasets/fitvto" npx playwright test e2e/dataset.spec.ts   # writes measurements.json
# Overlay check on one person: pad to 16:9 so Chromium doesn't crop the head off.
ffmpeg -loop 1 -i ../recordings/datasets/fitvto/fit0000_person.jpg -t 4 -r 15 \
  -vf "scale=-2:720,pad=1280:720:(ow-iw)/2:0:color=white,format=yuv420p" /tmp/fit0000.y4m
VFR_FAKE_VIDEO=/tmp/fit0000.y4m npx playwright test e2e/visual.spec.ts
```

Results on 30 samples (2026-11-16):

| Check | Result |
|---|---|
| Garment pipeline on 30 flat-lays | 30/30 processed, anchors on all 30, ~0.65 s each warm. Cutouts clean by eye. |
| Sleeve length vs true sleeve cm | 21/30. The misses were 3 sleeveless (read as short), 3 drooping long sleeves (read as short) and 3 sleeves of 28–34 cm (read as long). |
| Neckline | Almost all read as "high crew", V-necks included. Flat-lays show the inside back through the neck hole, so the outline has no dip. A neckline from color would be needed. |
| Long sleeves hanging down | The torso-width row at 62% height includes the sleeves, so the shoulder anchors drift outward. Not fixed: T-shirts are unaffected. |
| Chest width from the mask | Found on 2/30 people. At chest height, arms resting at the sides merge into the torso mask, with no confidence dip. The run is 1.5–1.9× shoulder span, so the gate rejects it. The recommendation falls back to shoulder width, and the note now asks the customer to hold their arms away from their sides. |
| Shoulder width vs true bust (14 full-body photos, 11 bodies, px/cm from known height) | r = 0.84, residual SD 5.9 cm. The same body measured 41 cm and 45.5 cm in two poses. |
| Overlay on 4 people | Face is never covered and the collar sits at the neck. A hand on the hip used to widen the shirt out to the elbow (cling marched into the arm); this is fixed by capping cling at each side's elbow and wrist. |

## 3D try-on cases (stand-in for live camera tests)

Each case is a 1280×720 fake-webcam clip built from one free photo (`backend/scripts/make_cases.py`; sources: FIT dataset, CC BY-NC-ND; Wikimedia Commons, CC licences listed in `recordings/datasets/commons/sources.json`). All data stays in the gitignored `recordings/datasets/`.

```bash
cd backend
.venv/bin/python scripts/make_cases.py <photo.jpg> ../recordings/datasets/cases/front.y4m still     # also: window, dim, closer, farther, sway, walk
cd ../frontend   # dev stack running
VFR_CASES="$PWD/../recordings/datasets/cases" npx playwright test e2e/tryon.spec.ts            # + VFR_DEBUG=wireframe,landmarks,mask
VFR_PERF_VIDEO=/abs/30fps-clip.y4m npx playwright test e2e/perf.spec.ts                        # real GPU frame rate
```

Every case saves a screenshot and the live geometry (`e2e/output/cases/<case>.png|json`) and asserts: hem inside the frame, crew collar below the chin, shirt width 0.95–1.4× the body when measurable, collar/hem jitter ≤ max(1.5 px, 1% of shoulder span) on still clips. `front.y4m` also runs the TEXT test.

Results, 2026-11-16 (13/13 automated checks pass; the verdict column is a by-eye review of the screenshots):

| Case | Source | Automated | By eye |
|---|---|---|---|
| Facing front | FIT fit0000 | pass | Pass. Collar under chin, face clear, sleeves on the shoulders. Reads as a stiff, boxy shell. |
| TEXT print | generated shirt on fit0000 | pass (red x 442 < blue x 516) | Pass. "TEXT" reads correctly. |
| Turn left | FIT fit2730 (yaw +0.57) | pass | Partial. Follows the turn; still looks flat-fronted. |
| Turn right | FIT fit3550 (yaw −0.49) | pass | Partial. Covers the torso; slightly narrow and short. |
| Arms raised | Commons raised033 | pass | Pass. Sleeves follow the arms up. |
| Arms crossed | Commons crossed017 | pass | Pass. Forearms draw over the shirt. |
| Hand on chest | Commons chest015 (no hips in frame) | pass | Pass. Hand and forearm over the shirt, hips banner shown. Shirt looks dull under the dark suit scene. |
| Closer | fit0130 scaled ×1.55 | pass | Pass. Hem stays in frame. |
| Farther | fit0130 scaled ×0.62 | pass | Pass. Slightly wide on a small figure (low-res mask). |
| Walk closer/farther | fit0130, scale 0.55→1.25→0.55 | pass | Pass. Size follows distance, no lag. |
| Sway (secondary motion, jitter) | fit0000 ±90 px | pass | Pass. Shirt stays on the body; hem lags slightly. |
| Bright window light | fit0130, cool side light | pass | Partial. Exposure and tint match; side shading is subtle. |
| Dim light | fit0130, ⅓ light, warm, noise | pass | Pass. Shirt darkens and gains grain. |
| Performance | perf30 clip, Metal GPU | 34–43 fps (median 42), detect ~23 ms | Pass (target 24+). |

These are photos played as a camera: a still image can't show real body motion, cloth behaviour or a real webcam's noise and exposure. M1–M11 with a live person remain the final check.

## Results from the build session (2026-11-16)

| Suite | Result |
|---|---|
| Backend pytest | 51 passed |
| Frontend vitest | 37 passed (3D renderer; the 2D-warp tests were removed with it) |
| Visual check, still photo of a real person | Passed; screenshots reviewed by eye |
| Playwright e2e | 3 passed |
| TypeScript `tsc` | clean |
| Persistence after restart | Verified: a fresh backend process served the stored products |

## Manual hardware tests — NOT yet performed

These need a person in front of the real webcam, a printed marker, or a real garment photo. Nobody has run them yet.

| # | Test | How |
|---|---|---|
| M1 | Real webcam in kiosk | Open `/`, allow the camera, and confirm the live image. |
| M2 | Real body tracking | Stand 2 m away. The pill should go Detecting → Tracking. Move and turn slightly; the overlay should follow without jumping. |
| M3 | Overlay alignment | Select a shirt and check that the collar sits at the neck and the face stays visible. Cross your forearms in front: they should show over the shirt. |
| M4 | Size switching | Switch S ↔ XL. The garment should resize with the shoulders still aligned, and the fit panel should update. |
| M5 | Tracking loss | Step out of view. The overlay should disappear (not freeze), and the session should reset after the idle timeout. |
| M6 | Camera unplug | Unplug a USB camera mid-session. Expect a "disconnected" message; Retry should recover. |
| M7 | Permission denied | Block the camera in site settings. Expect the permission message. |
| M8 | Calibration with a printed marker | Follow CALIBRATION.md and check that px/cm is plausible. Measure a known object at the same distance. |
| M9 | Size estimate | After calibrating, stand still with arms slightly out. A suggestion should appear with its confidence. Try it on people whose sizes are known. |
| M10 | Real T-shirt photo | Photograph a real shirt, process it, and check the cut-out and anchors. |
| M11 | Performance | Press **Alt+D** on the kiosk and record resolution, FPS, detect latency and delegate. Watch Activity Monitor for CPU and memory. |

## Measured performance (automated runs on this M1 Pro)

| Item | Value |
|---|---|
| rembg u2net, first image (model load) | ~1.9–2.0 s |
| rembg u2net, warm | ~0.5–0.8 s per image at ≤1600 px |
| Kiosk tracking FPS and latency | **Not measured.** Needs M11 with a real camera and browser. Headless Chromium with a fake camera does not represent the real GPU path. |
