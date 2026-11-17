# Development Checklist

Status values:

| Status | Meaning |
|---|---|
| `Not started` | No work done. |
| `In progress` | Partly built. |
| `Implemented` | Code exists. |
| `Tested` | An automated test passes. |
| `Verified` | Exercised end-to-end in the running app, in the Playwright e2e run against the real backend. |
| `Manual` | Implemented, but needs a human with real hardware: webcam plus person, printed marker, or real garment. Not yet done. |
| `Blocked` | Cannot proceed; the reason is given. |

Manual test IDs (M1–M11) refer to [docs/TESTING.md](docs/TESTING.md).

## Phase 0 — inspect and plan

| Requirement | Status | Notes |
|---|---|---|
| Inspect working directory | Verified | The folder held only the spec. |
| Check macOS / Apple Silicon / Python / Node / npm / disk | Verified | macOS 27.0.1, M1 Pro, 16 GB. Python 3.11.15, because 3.15 is too new for the wheels. Node 26.12, 34 GiB free. |
| Check webcam availability | Verified | `system_profiler` lists the FaceTime HD Camera. |
| Check package/model compatibility | Verified | OpenCV 5.0 ArUco; onnxruntime 1.32 (CoreML+CPU); rembg u2net; tasks-vision 1.2.3. |
| Architecture + API contracts | Implemented | docs/ARCHITECTURE.md |
| This checklist | Implemented | |

## Phase 1 — setup and camera

| Requirement | Status | Notes |
|---|---|---|
| Backend + frontend projects, pinned deps | Verified | requirements.txt and package.json pinned. |
| Live webcam feed in app | Verified (fake device) / Manual (M1) | Stream plumbing verified with Chromium's fake camera. The real webcam has not been tested. |
| Camera selection | Implemented | Dropdown appears with more than one camera; the choice is remembered per browser. |
| Configurable resolution / frame rate | Implemented | Settings → Kiosk camera. |
| Permission / no camera / busy / disconnect messages | Tested (unit messages) / Manual (M6, M7) | |
| Camera restart and cleanup | Verified | Retry button, tracks stopped on unmount. A StrictMode double-start leak was found by e2e and fixed. |

## Phase 2 — body tracking

| Requirement | Status | Notes |
|---|---|---|
| MediaPipe Pose Landmarker (local models, GPU→CPU fallback) | Verified (loads) / Manual (M2) | |
| Shoulders, elbows, wrists, hips, nose and face points | Implemented | |
| Shoulder span, torso length, center, visible chest width | Tested | |
| Visibility / in-frame check | Tested | "Step back a little" pill. |
| Smoothing; no fabricated landmarks; tracking-loss handling | Tested / Manual (M5) | One Euro filter; null below 0.5 visibility; 400 ms grace, then cleared. |
| Person segmentation | Implemented / Manual | Selfie segmenter, used for chest width. |
| Face never covered | Implemented / Manual (M3) | Head ellipse erased from the overlay. |
| Forearm and hand occlusion | Implemented / Manual (M3) | Capsule erase. Upper arms stay under the sleeves by design. |

## Phase 3 — calibration

| Requirement | Status | Notes |
|---|---|---|
| ArUco detection | Tested | Synthetic marker gives 300 px → 20 px/cm. Tilt and no-marker are rejected. |
| Printable marker | Tested | `/api/owner/calibration/marker.png` |
| Pixel-to-cm scale, saved, status, recalibrate, clear | Tested / Verified (UI error path) / Manual (M8) | |
| Intrinsic / checkerboard calibration | Not started | Deliberately left out of the MVP; documented as a limitation. |
| Limitations documented | Implemented | docs/CALIBRATION.md |

## Phase 4 — owner auth and dashboard

| Requirement | Status | Notes |
|---|---|---|
| Login, scrypt hashing, throttle | Tested, Verified | |
| Protected admin APIs | Tested | Every `/api/owner/*` route returns 401 without a session. |
| Logout invalidates the session | Tested | |
| First-owner creation documented | Implemented | `python -m app.cli create-owner` |
| Sidebar navigation (all 7 items) | Verified | |
| Overview from real DB data | Tested, Verified | |

## Phase 5 — image capture and upload

| Requirement | Status | Notes |
|---|---|---|
| Camera capture (select, capture, retake, confirm) | Verified (fake device) | |
| Upload: drag-and-drop, picker, PNG/JPG/WEBP | Verified (picker) | Drag-and-drop is implemented but not automated. |
| Content validation (type, size, dimensions, decode) | Tested, Verified | |
| Capture guidance shown | Implemented | |

## Phase 6 — garment processing

| Requirement | Status | Notes |
|---|---|---|
| Original preserved unchanged | Tested | |
| Real local background removal | Tested, Verified | rembg u2net. |
| Transparent PNG + mask, crop, normalize, aspect preserved | Tested | |
| Unsuitable image reported | Tested | Blank, low-contrast, too small or too large coverage. |
| Auto anchors | Tested (synthetic, 30 FIT flat-lays) / Manual (M10) | All 30 FIT flat-lays got anchors. Sleeve length 21/30; neckline type unreliable on flat-lays. See TESTING.md, "Public dataset checks". |
| Side-by-side original / processed | Verified | |
| Anchor editor (drag, keyboard), reset, rotate, crop, undo, retry, replace | Tested, Verified (keyboard nudge) | |

## Phase 7 — products and inventory

| Requirement | Status | Notes |
|---|---|---|
| CRUD, archive, delete with file cleanup | Tested | |
| Color variants | Tested, Verified | |
| XS–XXL per-size measurements with configurable limits | Tested, Verified | |
| Stock per color × size; low-stock and sold-out views | Tested | |
| Draft / publish with required-field validation | Tested, Verified | |
| Labelled sample seed | Verified | `seed-samples`, names prefixed `SAMPLE –`. |
| Persistence after restart | Verified | |

## Phase 8 — customer catalog

| Requirement | Status | Notes |
|---|---|---|
| Kiosk UI | Verified | |
| Only published, available products | Tested, Verified | |
| Sold-out sizes not selectable | Tested, Verified | |

## Phase 9 — virtual fitting

| Requirement | Status | Notes |
|---|---|---|
| Overlay on the live feed, anchor alignment, alpha blending | Tested / Verified (still photo, headless) / Manual (M3) | |
| Skinned mesh: torso quad, sleeves follow upper arms, lean, hip tilt, yaw foreshortening | Tested / Verified (still photo) | |
| Cling to body silhouette and real shoulder width | Tested / Verified (still photo, 4 FIT people) | Capped at each side's elbow and wrist, so a hand on the hip no longer widens the shirt. |
| Scene-matched lighting: exposure, white balance, regional light, fold transfer, AO, contact shadow, grain | Implemented / Verified (B&W still only) / Manual | White balance is unverified because the test photo was black and white. |
| Depth-aware forearm occlusion; upper arms over the torso but not the sleeves | Verified (still photo) / Manual | |
| Follows movement, smoothing, animated size changes | Manual (M2, M4) | A still photo can't show motion. |
| Size switching with a documented rule | Tested / Verified (still photo) | |
| Real-time performance with the new renderer | Manual (M11) | Not measured on real hardware. |

## Phase 10 — size recommendation

| Requirement | Status | Notes |
|---|---|---|
| Documented, configurable ease model | Tested | Settings → Size recommendation rules. |
| Compatible measurement definitions only | Tested | Circumference vs 2 × flat width. |
| Recommendation, fit, confidence, explanation, notes | Tested / Manual (M9) | FIT check: chest width found on only 2/30 people, because resting arms merge into the torso mask. Shoulder fallback vs true bust: r = 0.84, SD 5.9 cm. |
| Refuses when data is insufficient | Tested | |

## Phase 11 — integration and handover

| Requirement | Status | Notes |
|---|---|---|
| Owner-to-customer workflow | Verified | Without a real person; see the e2e run. |
| Session reset clears state; no frames stored or sent | Tested | |
| Performance measured | Partly done | rembg timings measured. Kiosk FPS needs M11. |
| Documentation | Implemented | |

## Phase 12 — 3D renderer rebuild (2026-11-16)

Verified = automated e2e case passes and the screenshot was reviewed (see TESTING.md, "3D try-on cases"). Cases use photos played as a fake camera, not a live person.

| Requirement | Status | Notes |
|---|---|---|
| Mirror only the video, never the shirt texture | Verified | TEXT e2e test: red/blue order and "TEXT" read correctly. Unit test: print left → display left. |
| Procedural T-shirt mesh: elliptical torso rings, tapered sleeves, real neck ring | Verified | `vision/tryon/shirt.ts`. |
| Crew collar below the chin, never over the face | Verified | Asserted in every case; unit test. |
| Cylindrical front projection, back photo on the back half, dominant colour elsewhere, aspect kept | Implemented / Tested | Back view is only seen when turning. |
| Background removal; front/back split of stacked photos; originals untouched | Tested | pytest `test_front_back_stack_is_split`; your 3 shirts split. |
| Style: slim / regular / oversized | Tested, Verified (regular) | Kiosk "Fit" picker. |
| Hips out of frame: estimated torso + banner | Verified | hand_on_chest case shows "Step back so your hips are in frame". |
| Hem never past the frame | Verified | Asserted every case; unit test. |
| One Euro smoothing; turn from shoulder depth | Verified | Turn cases: yaw ±0.5 rad. |
| Spring secondary motion; ≤10% stretch | Tested, Verified | Unit tests; sway/walk cases. |
| No jitter | Verified | Jitter ≤ max(1.5 px, 1% span) on all still cases. |
| Arms/hands in front draw over the shirt, 2–3 px feather, no ghosting | Verified | Arms crossed, hand on chest. |
| No blur or inpainting near the face; face and hair untouched | Verified | Hard head ellipse with 2 px feather; old neck/chin blur removed. |
| Light: brightness, contrast, colour temperature, direction | Verified (partial) | Dim light clearly matched; window side shading is subtle. |
| Fold normals, armpit/waist wrinkles, AO, contact shadows | Implemented | Visible but modest. Elbow wrinkles only on long sleeves. |
| Camera-matched blur and grain | Implemented | More grain in dim light. |
| 24+ fps on M1 | Verified | 34–43 fps (median 42) on M1 Pro, Metal GPU, 1280×720. |
| Shirts from ./Tshirts, scanned at startup | Verified | 3 shirts, front and back. |
| Debug panel: FPS, landmarks, mask, wireframe, light | Verified | Alt+D. |
| Realistic cloth look | Partial | Reads as a stiff, slightly boxy shell; no cloth simulation. |
| Live webcam and person | Manual | Not yet done (M1–M11). |

## Phase 13 — shirt mesh from the photos

Each sub-step stops for the owner's OK. Screenshots: `frontend/e2e/output/steps/`.

| Step | Status | Notes |
|---|---|---|
| A. Transparent cutouts (local rembg), originals untouched | Tested | `Tshirts/.cache/<key>.garment.png` (front) and `.back.png`. Edge decontamination removed the 1.png dark fringe (edge/interior luminance 1.02). Alpha feather 0.9–1.4 px. pytest `test_cutout_edges_carry_no_background_colour`. Screenshot `A_cutouts.png`. |
| B. Silhouette mesh, Delaunay, photo UVs | Tested | `backend/app/image_processing/garment_mesh.py`: outline + hex grid + Delaunay inside the silhouette, ~2.4–2.5k triangles per shirt. UVs = photo coordinates. Keypoints detected. pytest `test_mesh_from_photo`. Screenshot `B_mesh.png` (red = closed seam, cyan = open edge). |
| C. Inflate front/back shells, stitch seams | Tested | depth = k·√(distance to closed seams), capped at the chest; total thickness 0.35 × torso width. Shells share the outline; closed seams meet at 0, normals averaged there. Back photo mapped by mirrored keypoints; without one, the dominant colour. Screenshot `CD_mesh_turntable.png`. |
| D. Neck opening, hollow, open sleeves/hem | Tested | Crew opening cut in the front shell only; the inside shows the photographed inner back collar. Hem, cuffs and collar left open. pytest `test_whole_cuff_is_open`, `test_side_seams_and_shoulders_stay_closed`. |
| E. Keypoints pinned to body, deform within mask × fit factor | Verified with 1 failing case | Thin-plate spline for the torso (11 keypoints → body targets), rigid sleeves along the upper arm, width clamped to body × 1.05/1.12/1.25. Cases: front, 45°, 180°, arms raised, arms crossed, bright, dim pass. **90° profile fails**: MediaPipe keeps the shoulders apart in profile, so it reads as "back" and tracking drops in and out. Screenshots `EF_on_body.png`, `EF_closeups.png`. |
| F. Light match, turning, occlusion | Implemented (reused from Phase 12) / Verified on the cases above | Same renderer: room exposure, tint, light direction, contact shadow, grain, feathered occlusion. Turning: front/back from face landmarks or nose depth behind the shoulders, 6-frame hysteresis, smooth swing (no flicker in tests). |

### Still looks fake (updated after each step)

- After A: nothing fake in the cutouts themselves. Caveats: feather sits at the low end of 1–2 px on 1.png and 3.png. The bright rim on 2.png is real stitching and wash, checked on a green background. Front and back photos of 1.png and 3.png are near-identical, so turning will show little change for those two.
- After B–D: mesh outline matches each shirt; at 90° the shells meet with a soft edge. Preview only (raw mesh).
- After E/F, on the test photos (wardrobe shirts now use the photo mesh; catalog uploads still use the procedural shirt):
  - Reads as a flat sticker: shading is weak, folds are barely visible.
  - Sleeves look like flat flaps, especially with arms raised and from behind.
  - Shoulders sit slightly square; the wearer's own collar can show above the shirt.
  - Thin dark line where the shirt's sleeve edge meets the arm (arms crossed).
  - 90° profile fails (tracking). A real 45° clip was not available; the "45°" case is about 33°.
  - Back view shows the back photo, but with near-identical front/back photos (1.png, 3.png) the turn adds little.
  - Front/back switching: MediaPipe reports a face even from behind, so detection relies on nose depth, which caught only about half of the back-view photos.

## Phase 14 — step E redo (owner's live test: misaligned shoulders, visible inside, big neck hole, clothes peeking, drift)

Each fix stops for the owner's OK. Screenshots: `frontend/e2e/output/steps/FIX*.png`.

| Fix | Status | Notes |
|---|---|---|
| 1. Shoulder anchoring (pins) | Tested; owner checked live, then fixed | Shoulder tips pinned to the shoulder landmarks, neck base 0.25 × shoulder width above their midpoint, armpits 35% down to the hips, hem corners at hip level; scale and tilt from the shoulder pins; TPS for the rest; One Euro on every pin; sleeves centred on the arms with their width capped (0.34 × span × fit factor). Debug overlay (Alt+D, landmarks): orange = body pins, cyan = shirt keypoints. Fixed: skewed local frame with tilted shoulders; sleeve spring offset used as a position (sleeves collapsed); sleeves hung inward from their top edge. Unit tests: tips on landmarks (level and tilted), neck height, sleeve width, sleeve symmetry. Cases pass: front, tilt, 45°, 180°, arms raised, arms crossed. 90° fails (tracking). Owner's live screenshot showed the seam too low: MediaPipe shoulder landmarks are the joints, 60–90 px inside the body. Now the seam is pinned to the shoulder top found by walking up the person mask from each joint (fallback 0.12 span). |
| 2. Body blocks the shirt (depth, culling, stretched triangles) | Verified on cases | The shirt's mid-surface (between the shells, turning with them) is written into depth where the person mask is set, minus the collar opening: front shell over the body, back shell hidden behind it. Outer-face culling on the photo mesh. Clamped edge vertices relaxed twice (no stretched triangles). Alt+D wireframe now colours shells (front blue, back red): `FIX2_shells_wireframe.png` shows no red over the body at 0° and 45°; red faces the camera at 180°. First attempt used a flat body plane: back shell showed over the body at 45°; fixed. |
| 3. Neckline | Verified on cases | Neck points at the measured neck width × 1.15 (mask, just above the neck base); neck occluder sized to it; ~2.5 cm darker ribbed collar band and inner shadow; front neckline below the chin. `FIX3_neck_closeups.png`. |
| 4. Cover current clothes | Implemented / partial | Composite pass: person-mask pixels near the shirt, outside it, take the background found by walking outward to the silhouette edge. Face, neck, both arms and hands are protected (capsules, 2.5 px feather). Hint "Wear a plain fitted top for the best result" when the top is much wider than a body. |
| 5. Tracking (step back, freeze) | Verified on cases | Shoulders near the edge, hips out of frame or visibility < 0.7 → "Step back" banner + dashed silhouette guide; the photo shirt freezes at the last good fit (nothing drawn before the first). Case `stepback_close` (hips out) passes. |

### Realism pass R1 (2026-11-16)

| Change | Result |
|---|---|
| Shading transfer: blurred (0.12 span) real luminance under the shirt vs the torso average, strength 0.35, range 0.85–1.12 | The light falloff of the room now lies on the shirt. A first, sharper version carried the customer's own print and black/skin blotches through; it was blurred and weakened. |
| Wrap (half-Lambert) lighting | Shoulder tops and sides no longer go dark (no "shelf"). |
| Fold shading: broad armpit drag folds, gravity drape, waist bunching; fold valleys darker, ridges lighter (±14%) | Folds now visible on the body (frontal light hides normal-only folds). |
| ~2 px edge feather; clean-up stops at the frame edge | Softer outline; no dark bar from the frame edge. |

### Still looks fake (after R1)

- Silhouette reads as a stiff cut-out: straight sides and hem, square shoulder corners.
- Folds are procedural and a little regular; they don't react to movement.
- Own sleeves still show below the shirt sleeves; with arms raised the sleeves don't follow well.
- A dark crew collar of the customer's own top can show inside the neck opening.
- Clean-up needs plain background beside the body.
- 90° profile still fails (tracking).
