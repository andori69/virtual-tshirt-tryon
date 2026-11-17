# Architecture

```
Browser (kiosk / owner)                          Backend (FastAPI, :8000)
───────────────────────                          ────────────────────────
getUserMedia ─► <video>                          /api/auth/*        owner sessions (cookie)
   │                                             /api/owner/*       products, sizes, colors, stock,
   ▼                                                                image upload + processing, anchors,
MediaPipe PoseLandmarker (GPU→CPU fallback)                         inventory, overview, calibration, settings
MediaPipe ImageSegmenter (selfie)                /api/catalog       published, in-stock products only
   │  landmarks, person mask                     /api/kiosk/config  camera settings, calibration scale
   ▼                                             /api/fitting/recommend  stateless size estimate
smoothing (One Euro) ─► garment transform        /assets/processed, /assets/thumbs  (public garment PNGs)
   │                    ─► canvas overlay
   ▼                                             rembg (u2net, onnxruntime) ─ background removal
body sample window ─► POST /recommend            OpenCV ─ mask cleanup, ArUco detection
                                                 SQLite via SQLAlchemy
```

## Decisions

- **Pose tracking runs in the browser.** The spec suggested backend tracking over WebSocket. Running MediaPipe in the browser keeps customer frames on the kiosk, avoids streaming video to a server, and keeps the overlay in sync with the frame it was computed on. No WebSocket is used because nothing needs one. `vision/tracker.ts` is the only module that touches MediaPipe.
- **Image processing runs on the backend.** rembg/u2net is too large for the browser. Upload endpoints are synchronous `def` routes, so they run in FastAPI's thread pool and never block the event loop. The kiosk pipeline is in the browser and isn't affected. A lock serializes inference to bound memory.
- **Model choice.** `u2net` (Apache-2.0, 176 MB) is rembg's general-purpose default. It takes about 0.5–0.8 s per image on M1 once warm and about 2 s on first load. Set `VFR_REMBG_MODEL` to swap it.
- **Auth.** Passwords use stdlib `scrypt` with a per-password salt. Sessions are random tokens; only their SHA-256 is stored server-side. The cookie is HttpOnly and SameSite=Strict. Logout deletes the session, and an in-memory throttle locks a username after 8 failures for 5 minutes.
- **Schema setup.** `create_all` runs at startup. Adopt Alembic once the schema has to change under live data.

## Data model

| Table | Purpose |
|---|---|
| `owners`, `owner_sessions` | Owner accounts and server-side sessions |
| `products` | Name, brand, description, price, currency, status (`draft` / `published` / `archived`), `is_sample`, timestamps |
| `variants` | Colors of a product (name, hex) |
| `product_sizes` | Per-size garment measurements in cm, shared by all colors |
| `inventory` | Stock per color × size |
| `garment_images` | Per color and view (`front` now; extensible): original, cut-out, processed, mask and thumbnail paths; auto and edited anchors; `anchors_confirmed`; processing metadata and errors |
| `calibrations` | ArUco scale results; one active |
| `settings` | Store-tunable JSON: fit rules, measurement limits, store, camera |

Deletes run DB-first, then file removal. A failed file delete leaves an orphan file, never a dangling DB reference. Replacing or adjusting an image deletes the superseded files. The original is never overwritten.

## Publishing rules

A product can be published only with: a name, a price above 0, at least one size, and at least one color whose image is processed with confirmed anchors and at least one in-stock size. The catalog additionally hides colors that aren't ready and products with nothing in stock. Customers see availability flags, not stock counts.

## Garment processing

1. Validate the upload by content: size limit, real format (PNG/JPEG/WEBP via Pillow), full decode, dimension limits, and a decompression-bomb guard. The original bytes are stored unchanged under a random name.
2. Apply EXIF orientation and downscale to at most 1600 px for the model.
3. rembg/u2net produces an alpha matte.
4. Keep the largest connected component. Reject if it covers under 3% or over 97% of the image, or if its color is indistinguishable from the surrounding background (Lab ΔE < 6), because the model always returns *something*. Fill interior holes and keep the soft edge.
5. Crop to alpha, then fit onto a 1024×1024 transparent canvas, aspect preserved and centered. Write the mask and thumbnail.
6. Estimate anchors heuristically:
   - torso edges from the row at 62% of garment height;
   - shoulder seams from the top contour just inside the torso edges;
   - the neckline as the top of the center column;
   - sleeve tips as the extreme x points;
   - hem corners from the bottom rows.
   The owner must confirm or drag them before publishing.
7. Owner tools: rotate ±2°, crop rectangle, undo rotate/crop (re-normalizes from the stored cut-out), retry (re-runs the model on the original), replace.

Anchor coordinates are fractions (0–1) of the processed canvas, so they are display-size independent. "Left" and "right" mean **picture** left and right.

## Fitting engine (3D, `frontend/src/vision/tryon/`)

The shirt is a procedural 3D mesh wrapped around the tracked body and drawn with Three.js. It replaced the earlier 2D photo warp.

**Display space and mirroring** (`rig.ts`). The selfie view is mirrored, but only the video: the renderer draws the mirrored camera frame and builds the shirt directly in display coordinates (`x_display = W - x_video`). The product photo is never flipped, so printed text reads correctly. This is checked by the `TEXT print reads correctly` e2e test (a red block left of a blue block on the photo must appear left of it on screen).

**Body rig** (`rig.ts`), from One-Euro-smoothed landmarks plus MediaPipe world landmarks (metres → pixels at the shoulders' scale, z toward the viewer):
- shoulders, spine (shoulders → hips), torso turn (yaw from the shoulders' depth difference, One Euro smoothed);
- hips, or, when they are out of frame, an estimate at 1.4 × shoulder span below the shoulders plus the kiosk banner "Step back so your hips are in frame";
- the collar ring at the base of the neck (0.16 span above the shoulder joints), pushed down if needed so the top of the crew rib stays at least 0.02 span below the chin;
- arms (shoulder, elbow, wrist, hand points) and whether each wrist is clearly (≥ 6 cm) in front of the chest;
- body silhouette half-widths at six heights from the low-res person mask (256 px wide). Each side stops where the arm crosses that row, so a resting or A-pose arm is never taken for torso.

**Mesh** (`shirt.ts`):
- **Torso:** 22 elliptical rings × 48 segments from the shoulder line to the hem. Width = body silhouette width (or a shoulder-based estimate) × style ease; depth = width × 0.5–0.62. Rings are rotated by the torso turn.
- **Yoke and collar:** rows from the neck ring down to the shoulder line, with a crew dip at the front and a rib band.
- **Sleeves:** tapered tubes along shoulder → elbow (→ wrist for long sleeves), with a rounded cap. Sleeveless shirts have none.
- **Style:** `slim` / `regular` / `oversized` (kiosk "Fit" picker) set ease, shoulder width, boxiness, length and sleeve width. Boxy width comes from chest/waist rows only, so hips and skirts don't turn the shirt into a poncho. Catalog sizes scale width and length by their chest/length ratio to the reference size.
- **Length:** from the photo's own length/shoulder proportion, clamped to 0.8–1.35 × the body's shoulder-to-hip length. The hem never goes below the frame: the shirt (and its print) is cropped, not squashed.
- **Texture:** cylindrical projection of the front photo on the front half (u follows the angle around the body, so the print curves and the sides fall away); the back photo (if the folder image showed front above back) on the back half, else the dominant colour. Print aspect is kept by sampling a wider or narrower photo range. Inside surfaces use the dominant colour, darkened.
- **Motion:** 10% stretch limit on the shirt's shape (in shoulder spans, so walking closer/farther still scales freely); spring-damped hem and sleeve ends, capped at 10% of their length.
- **Folds:** normals perturbed by armpit drag folds and waist bunching, plus ambient occlusion at armpits, sides, collar and hem.

**Rendering** (`renderer.ts`):
- Pass 1: depth-only occluders (neck, upper arms, forearms, hands) then the shirt. A forearm whose wrist is in front of the chest is moved in front of everything; otherwise arms keep their world depth, so an arm beside the body covers the shirt's side and hands behind the back stay hidden.
- Shirt shader: luminance bump from the photo, Lambert light from the estimated direction (deeper shading when the side light is strong), exposure, contrast, colour tint.
- Pass 2 (screen): the camera frame captured right before detection (so the shirt is never drawn on a newer frame than its pose), the shirt over it with a 2–3 px feathered edge, the face ellipse hard-protected (2 px feather, no blur or inpainting near the face), a soft contact shadow on the person below the shirt, camera-matched blur and grain (more grain in dim light).

**Scene light** (`lighting.ts`), every 6 frames from a 96×54 copy: exposure from the frame and face (not the torso: that is the customer's own clothes), gentle contrast, gray-world tint, light direction from the face and torso gradients. Blended over time.

**Debug panel** (Alt+D): FPS, detect latency, GPU delegate, light estimate, and toggles for the landmark overlay, mask preview and mesh wireframe. Alt+R turns the realism passes off. `window.__vfr` exposes live geometry numbers for the e2e tests.

**Performance:** measured 34–43 fps (median 42) at 1280×720 on the M1 Pro with full Chromium and the Metal GPU (`e2e/perf.spec.ts`); pose detection ~23 ms; segmentation runs at 256 px wide every other frame.

**Not cloth simulation.** The mesh follows the body procedurally; folds are shading, not physics. The back photo is only seen when the customer turns.

## Fit model (`backend/app/fitting/recommend.py`)

- **Shoulder span:** median shoulder-landmark span over a window of up to 60 tracked frames.
- **Visible chest width:** the width of the person-mask run at about armpit level (22% down the torso). It is rejected when it touches the frame edge or exceeds 1.45× the shoulder span (arms merged in).
- **Unit conversion:** pixels become cm using the active calibration, scaled by frame width when the resolution differs (same field of view assumed).
- **Body chest circumference:** an ellipse estimate. Width = visible chest width; depth = width × `body_depth_ratio` (default 0.72).
- **Garment chest circumference:** 2 × flat chest width.
- **Ease:** garment circumference − body circumference. Configurable bands give Tight (< 4 cm), Regular (< 12), Relaxed (< 20) or Oversized.
- **Fallback:** without chest width, the garment shoulder width is compared to the estimated seam width with its own bands, at reduced confidence.
- **Recommendation:** the size closest to the center of the preferred band, plus the closest in-stock size when that differs.
- **Confidence:** mean landmark visibility × a stability factor, × 0.6 without chest width, × 0.7 if the aspect ratio differs from calibration.
- **Refusals:** the kiosk says it can't recommend without calibration, with fewer than 5 samples, or below `min_confidence`.

## Privacy

- No frames are uploaded, stored or sent to third parties. MediaPipe models are served locally.
- No face recognition. The face region is used only to keep it uncovered.
- Body samples live in browser memory, are sent only to the local `/recommend` call, and are never persisted. **End session**, or `kiosk_idle_reset_s` with no one in view, clears the selection, the recommendation and all samples.

## Known limitations

- The 3D shirt was checked on photos (FIT dataset, Wikimedia Commons) played as a fake camera, not on a live person. See [TESTING.md](TESTING.md).
- Procedural mesh, not cloth simulation: the shirt reads as a stiff, slightly boxy shell; it doesn't drape or wrinkle with motion.
- Calibration scale is valid only at the marker's distance. There is no lens-distortion correction (checkerboard intrinsics not implemented).
- Chest estimation degrades with arms against the body, loose clothing, or the customer turned sideways.
- Single-person tracking (`numPoses: 1`).
- Anchor auto-detection is heuristic and assumes a front-facing, upright T-shirt. Owner confirmation is mandatory.
- The login throttle is in memory and resets when the backend restarts.
- No schema migrations (`create_all`).
