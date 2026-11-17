"""Heuristic garment anchor estimation from a front-view T-shirt mask.

All anchors use image sides: "left" means the left side of the picture, which is what the overlay engine
matches to the left-most shoulder in the (unmirrored) camera frame. Coordinates are normalized 0..1 relative
to the processed canvas so they stay valid at any display size.
"""
import numpy as np

ANCHOR_KEYS = (
    "left_shoulder", "right_shoulder", "neckline_center", "left_sleeve", "right_sleeve",
    "left_hem", "right_hem", "bottom_center",
)


class AnchorEstimationError(ValueError):
    pass


def _top_y(mask: np.ndarray, x: int) -> int | None:
    ys = np.flatnonzero(mask[:, x])
    return int(ys[0]) if ys.size else None


def estimate_anchors(mask: np.ndarray) -> dict[str, dict[str, float]]:
    """mask: HxW bool array of the garment on its normalized canvas."""
    h_img, w_img = mask.shape
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        raise AnchorEstimationError("Mask is empty.")
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    h = y1 - y0 + 1

    # Torso edges well below the sleeves of a T-shirt.
    mid_row = mask[int(y0 + 0.62 * h)]
    mid_xs = np.flatnonzero(mid_row)
    if mid_xs.size < 2:
        raise AnchorEstimationError("Could not find the shirt body.")
    torso_l, torso_r = int(mid_xs[0]), int(mid_xs[-1])
    torso_w = torso_r - torso_l
    cx = (torso_l + torso_r) // 2

    neck_y = _top_y(mask, cx)
    sl_x, sr_x = int(torso_l + 0.06 * torso_w), int(torso_r - 0.06 * torso_w)
    sl_y, sr_y = _top_y(mask, sl_x), _top_y(mask, sr_x)
    if neck_y is None or sl_y is None or sr_y is None:
        raise AnchorEstimationError("Could not find the shoulder line.")

    hem_band = mask[max(y0, y1 - int(0.03 * h)): y1 + 1]
    hem_xs = np.flatnonzero(hem_band.any(axis=0))
    hem_l, hem_r = int(hem_xs[0]), int(hem_xs[-1])

    def tip(edge_x: int) -> tuple[int, int]:
        col_ys = np.flatnonzero(mask[:, edge_x])
        return edge_x, int(np.median(col_ys))

    lsx, lsy = tip(int(x0))
    rsx, rsy = tip(int(x1))

    # Sanity: the neckline sits in the top third and the sleeve tips below the shoulders.
    if not (y0 <= neck_y <= y0 + 0.35 * h):
        raise AnchorEstimationError("Neckline position looks implausible.")
    if torso_w < 0.3 * h:  # a T-shirt body is far wider than 30% of its length
        raise AnchorEstimationError("Shirt body is too narrow; the outline may be wrong.")

    pts = {
        "left_shoulder": (sl_x, sl_y),
        "right_shoulder": (sr_x, sr_y),
        "neckline_center": (cx, neck_y),
        "left_sleeve": (lsx, lsy),
        "right_sleeve": (rsx, rsy),
        "left_hem": (hem_l, int(y1)),
        "right_hem": (hem_r, int(y1)),
        "bottom_center": ((hem_l + hem_r) // 2, int(y1)),
    }
    return {k: {"x": round(x / w_img, 4), "y": round(y / h_img, 4)} for k, (x, y) in pts.items()}


def validate_anchors(anchors: dict) -> dict[str, dict[str, float]]:
    out = {}
    for key in ANCHOR_KEYS:
        p = anchors.get(key)
        if not isinstance(p, dict):
            raise AnchorEstimationError(f"Missing anchor: {key}.")
        x, y = float(p.get("x", -1)), float(p.get("y", -1))
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise AnchorEstimationError(f"Anchor {key} is outside the image.")
        out[key] = {"x": round(x, 4), "y": round(y, 4)}
    if out["left_shoulder"]["x"] >= out["right_shoulder"]["x"]:
        raise AnchorEstimationError("Left shoulder must be to the left of the right shoulder.")
    if out["neckline_center"]["y"] >= out["bottom_center"]["y"]:
        raise AnchorEstimationError("Neckline must be above the bottom of the shirt.")
    return out
