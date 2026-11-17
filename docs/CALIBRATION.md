# Camera calibration

Calibration converts pixels to centimetres so the kiosk can draw sizes at real scale and estimate body size. Without it, try-on still works: sizes are then drawn relative to each other, and the kiosk says it can't estimate a size.

## Steps

1. Mount the kiosk camera in its final position and set its resolution in **Settings → Kiosk camera**.
2. **Owner → Camera Calibration → Open the marker image** (ArUco `DICT_4X4_50`, id 0) and print it about 15 cm wide on plain, flat paper. Stiff card is better.
3. Measure the **black square's side** with a ruler and enter it. Printer scaling doesn't matter, because you enter what you measured.
4. Hold the marker flat and upright **where customers stand**, at chest height, facing the camera, fully visible and evenly lit.
5. **Capture & detect.** The outline is drawn and the px/cm is shown. If the marker is tilted (side ratio > 1.15) it is rejected; hold it straighter.
6. **Save calibration.** The server re-detects from the frame instead of trusting the browser's numbers.

Recalibrate when the camera moves, zooms, or changes resolution. A different resolution with the same aspect ratio is scaled automatically. A different aspect ratio lowers confidence and should be recalibrated.

## What is measured, what is estimated

| Quantity | Status |
|---|---|
| Marker side in px | Measured (sub-pixel corners) |
| px/cm at the marker's plane | Measured |
| Customer shoulder seam width | Estimated: landmark span × factor, assuming the customer stands where the marker was |
| Customer visible chest width | Estimated from the person mask; poor when arms touch the body |
| Customer chest circumference | Approximated: ellipse with an assumed depth ratio. A single camera can't see depth. |

Known gaps:
- The scale is valid only at one depth. A customer 20 cm closer than the marker appears roughly 10% larger at 2 m.
- Lens distortion is not corrected; checkerboard intrinsic calibration is not implemented. It matters little near the frame center.
- A depth camera or multi-view capture would be the right upgrade for real circumference estimates. That is out of scope for this MVP.
