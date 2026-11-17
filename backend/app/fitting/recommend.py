"""Size recommendation from 2D body estimates and the owner's flat garment measurements.

Measurement definitions (see docs/ARCHITECTURE.md, "Fit model"):
- The camera sees a *visible front width* of the chest, not a circumference.
- Body chest circumference is estimated as an ellipse: width = visible chest width, depth = width x body_depth_ratio.
- Garment chest circumference ~ 2 x flat chest width (armpit to armpit, laid flat).
- ease = garment circumference - estimated body circumference; fit category comes from configurable ease bands.
- Without chest width, garment shoulder width is compared to the estimated shoulder seam width instead.
Every value is an estimate; the confidence score expresses how much the inputs can be trusted.
"""
import math
from dataclasses import dataclass

FIT_ORDER = ("tight", "regular", "relaxed", "oversized")


@dataclass
class BodySample:
    shoulder_span_px: float
    frame_width: int
    frame_height: int
    chest_width_px: float | None = None
    torso_length_px: float | None = None
    visibility: float = 1.0           # mean landmark visibility 0..1
    stability_cv: float = 0.0          # coefficient of variation of shoulder span over the sample window
    samples: int = 1


@dataclass
class SizeSpec:
    label: str
    chest_width_cm: float
    shoulder_width_cm: float
    length_cm: float
    in_stock: bool = True


@dataclass
class CalibrationInfo:
    px_per_cm: float
    frame_width: int
    frame_height: int


def ellipse_circumference(width: float, depth: float) -> float:
    a, b = width / 2, depth / 2
    h = ((a - b) ** 2) / ((a + b) ** 2)
    return math.pi * (a + b) * (1 + 3 * h / (10 + math.sqrt(4 - 3 * h)))  # Ramanujan II


def _category(value: float, bands: tuple[float, float, float]) -> str:
    for cat, upper in zip(FIT_ORDER, bands):
        if value < upper:
            return cat
    return "oversized"


def _band_center(bands: tuple[float, float, float], idx: int, pad: float) -> float:
    # Open-ended bands (tight, oversized) get a finite width of `pad` so they still have a center.
    lo = bands[idx - 1] if idx > 0 else bands[0] - pad
    hi = bands[idx] if idx < 3 else bands[2] + pad
    return (lo + hi) / 2


def recommend(body: BodySample, sizes: list[SizeSpec], cal: CalibrationInfo | None, rules: dict) -> dict:
    if not sizes:
        return {"status": "insufficient", "reason": "This product has no size measurements."}
    if cal is None:
        return {
            "status": "insufficient",
            "reason": "The camera has not been calibrated, so body size cannot be estimated in centimetres.",
        }
    if body.samples < 5 or body.shoulder_span_px <= 0:
        return {"status": "insufficient", "reason": "Not enough stable tracking data yet. Please stand still."}

    # Same camera, different resolution: scale grows linearly with frame width (same field of view assumed).
    ppcm = cal.px_per_cm * body.frame_width / cal.frame_width
    aspect_mismatch = abs(body.frame_width / body.frame_height - cal.frame_width / cal.frame_height) > 0.02

    shoulder_cm = body.shoulder_span_px / ppcm * rules["shoulder_landmark_factor"]
    chest_front_cm = body.chest_width_px / ppcm if body.chest_width_px else None
    chest_circ_cm = (
        ellipse_circumference(chest_front_cm, chest_front_cm * rules["body_depth_ratio"]) if chest_front_cm else None
    )

    confidence = max(0.0, min(1.0, body.visibility))
    confidence *= max(0.5, 1 - 5 * body.stability_cv)
    notes = [
        "Estimates assume you stand where the calibration marker was held.",
        "A single front camera cannot measure depth, so chest size is approximated.",
    ]
    if chest_circ_cm is None:
        confidence *= 0.6
        notes.append(
            "Chest width was not visible, so the estimate uses shoulder width only. "
            "Hold your arms a little away from your sides for a better estimate."
        )
    if aspect_mismatch:
        confidence *= 0.7
        notes.append("Camera aspect ratio differs from calibration; recalibrate for better accuracy.")
    confidence = round(confidence, 2)

    ease_bands = (rules["ease_tight_max_cm"], rules["ease_regular_max_cm"], rules["ease_relaxed_max_cm"])
    shoulder_bands = (rules["shoulder_tight_cm"], rules["shoulder_relaxed_cm"], rules["shoulder_oversized_cm"])
    preferred = rules["preferred_fit"]
    pref_idx = FIT_ORDER.index(preferred)
    ease_target = _band_center(ease_bands, pref_idx, 8)
    shoulder_target = _band_center(shoulder_bands, pref_idx, 4)

    results = []
    for s in sizes:
        shoulder_diff = s.shoulder_width_cm - shoulder_cm
        if chest_circ_cm is not None:
            ease = 2 * s.chest_width_cm - chest_circ_cm
            cat = _category(ease, ease_bands)
            score = abs(ease - ease_target)
        else:
            ease = None
            cat = _category(shoulder_diff, shoulder_bands)
            score = abs(shoulder_diff - shoulder_target)
        results.append({
            "label": s.label,
            "fit": cat,
            "chest_ease_cm": round(ease, 1) if ease is not None else None,
            "shoulder_diff_cm": round(shoulder_diff, 1),
            "in_stock": s.in_stock,
            "_score": score,
        })

    body_est = {
        "shoulder_width_cm": round(shoulder_cm, 1),
        "chest_visible_width_cm": round(chest_front_cm, 1) if chest_front_cm else None,
        "chest_circumference_cm": round(chest_circ_cm, 1) if chest_circ_cm else None,
        "torso_length_cm": round(body.torso_length_px / ppcm, 1) if body.torso_length_px else None,
    }
    if confidence < rules["min_confidence"]:
        for r in results:
            r.pop("_score")
        return {
            "status": "insufficient",
            "reason": "Tracking confidence is too low to recommend a size. Stand facing the camera with shoulders and hips visible.",
            "confidence": confidence,
            "body_estimate": body_est,
            "sizes": results,
            "notes": notes,
        }

    best = min(results, key=lambda r: r["_score"])
    in_stock = [r for r in results if r["in_stock"]]
    best_available = min(in_stock, key=lambda r: r["_score"]) if in_stock else None
    for r in results:
        r.pop("_score")

    basis = "chest ease" if chest_circ_cm is not None else "shoulder width"
    explanation = (
        f"Size {best['label']} gives the closest to a {preferred} fit based on {basis}"
        + (f" (about {best['chest_ease_cm']:+.0f} cm of room around the chest)." if best["chest_ease_cm"] is not None else ".")
    )
    if not best["in_stock"] and best_available:
        explanation += f" It is out of stock; {best_available['label']} is the closest available size."
    return {
        "status": "ok",
        "recommended": best["label"],
        "recommended_available": best_available["label"] if best_available else None,
        "confidence": confidence,
        "confidence_label": "high" if confidence >= 0.75 else "medium" if confidence >= 0.5 else "low",
        "explanation": explanation,
        "body_estimate": body_est,
        "sizes": results,
        "notes": notes,
    }
