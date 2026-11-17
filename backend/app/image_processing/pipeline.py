"""Garment asset generation: real local background removal (rembg) -> clean mask -> crop -> normalized canvas."""
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

from .. import config
from .anchors import AnchorEstimationError, estimate_anchors

log = logging.getLogger(__name__)

CANVAS = 1024
MARGIN = 0.04
MODEL_MAX_SIDE = 1600
THUMB = 320
MIN_CONTRAST = 6.0  # Lab distance between garment and surrounding background medians

_session = None
_lock = threading.Lock()


class GarmentProcessingError(RuntimeError):
    """User-facing processing failure."""


@dataclass
class GarmentAssets:
    cutout: Image.Image      # tight-cropped RGBA straight from segmentation (input for re-normalizing)
    processed: Image.Image   # RGBA on the normalized square canvas
    mask: Image.Image        # L, 0/255
    thumb: Image.Image
    anchors: dict | None
    meta: dict = field(default_factory=dict)


def _get_session():
    global _session
    if _session is None:
        from rembg import new_session  # heavy import, deferred until first use

        t = time.perf_counter()
        _session = new_session(config.REMBG_MODEL)
        log.info("rembg %s loaded in %.1fs", config.REMBG_MODEL, time.perf_counter() - t)
    return _session


def _segment(img: Image.Image) -> np.ndarray:
    from rembg import remove

    with _lock:  # one inference at a time keeps memory bounded
        out = remove(img, session=_get_session(), post_process_mask=True)
    return np.array(out.convert("RGBA"))


def _clean(rgba: np.ndarray, rgb: np.ndarray) -> tuple[np.ndarray, list[str], dict]:
    """rgba: segmentation output (rembg blacks out the background); rgb: the original pixels."""
    alpha = rgba[:, :, 3]
    binary = (alpha > 127).astype(np.uint8)
    total = binary.size
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if n <= 1:
        raise GarmentProcessingError(
            "No garment was found in the photo. Use a plain background that contrasts with the shirt."
        )
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    keep = (labels == best).astype(np.uint8)
    coverage = float(keep.sum()) / total
    if coverage < 0.03:
        raise GarmentProcessingError(
            "The detected garment is very small. Move the camera closer so the shirt fills most of the photo."
        )
    if coverage > 0.97:
        raise GarmentProcessingError(
            "The background could not be separated from the shirt. Use a plain background with more contrast."
        )

    # The model always returns *something*; reject results where the "garment" looks like its surroundings.
    ring = cv2.dilate(keep, np.ones((61, 61), np.uint8)).astype(bool) & ~keep.astype(bool)
    if ring.any():
        lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(float)
        delta = float(np.linalg.norm(np.median(lab[keep.astype(bool)], 0) - np.median(lab[ring], 0)))
        if delta < MIN_CONTRAST:
            raise GarmentProcessingError(
                "The shirt could not be told apart from the background. Use a plain background with a different color."
            )

    # Fill interior holes (prints that matched the background) by flood-filling the outside.
    flood = np.pad(keep, 1)  # zero border guarantees (0, 0) is outside the garment
    cv2.floodFill(flood, None, (0, 0), 2)
    holes = flood[1:-1, 1:-1] == 0
    solid = keep.astype(bool) | holes

    # Keep rembg's soft edge just around the kept component; drop everything else.
    soft = cv2.dilate(solid.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    out_alpha = np.where(soft, alpha, 0).astype(np.uint8)
    out_alpha[holes] = 255
    rgba = rgba.copy()
    rgba[:, :, 3] = out_alpha

    warnings = []
    h, w = solid.shape
    edges = {"top": solid[0], "bottom": solid[-1], "left": solid[:, 0], "right": solid[:, -1]}
    touched = [k for k, e in edges.items() if e.mean() > 0.02]
    if touched:
        warnings.append(f"The shirt touches the {', '.join(touched)} edge of the photo and may be cut off.")
    n_comp_large = int((stats[1:, cv2.CC_STAT_AREA] > 0.01 * total).sum())
    if n_comp_large > 1:
        warnings.append("Other objects were detected and removed; check the result.")
    return rgba, warnings, {"coverage": round(coverage, 4), "holes_filled_px": int(holes.sum())}


def _defringe(rgba: np.ndarray, band: int = 3) -> np.ndarray:
    """The old background bleeds into the cut-out's edge (a dark line around a light shirt shot on black). Edge pixels
    take the colour of the nearest solid interior pixel, and the alpha edge is pulled in by 1 px."""
    alpha = rgba[:, :, 3]
    core = cv2.erode((alpha > 250).astype(np.uint8), np.ones((3, 3), np.uint8), iterations=band)
    if not core.any():
        return rgba
    # Labels count core pixels in raster order, so label k is the k-th entry of np.nonzero(core).
    _, labels = cv2.distanceTransformWithLabels(1 - core, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(core)
    edge = (alpha > 0) & (core == 0)
    out = rgba.copy()
    near = labels[edge] - 1
    out[edge, :3] = rgba[ys[near], xs[near], :3]
    out[:, :, 3] = cv2.erode(alpha, np.ones((3, 3), np.uint8))
    return out


def _crop_to_alpha(img: Image.Image) -> Image.Image:
    bbox = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if bbox is None:
        raise GarmentProcessingError("Nothing is left of the garment after this edit.")
    return img.crop(bbox)


def normalize(cutout: Image.Image) -> GarmentAssets:
    """Fit the cropped garment, aspect preserved, centered on a CANVAS x CANVAS transparent square."""
    cutout = _crop_to_alpha(cutout)
    box = CANVAS * (1 - 2 * MARGIN)
    scale = min(box / cutout.width, box / cutout.height)
    size = (max(1, round(cutout.width * scale)), max(1, round(cutout.height * scale)))
    resized = cutout.resize(size, Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    offset = ((CANVAS - size[0]) // 2, (CANVAS - size[1]) // 2)
    canvas.paste(resized, offset)

    alpha = np.array(canvas.getchannel("A"))
    mask_bool = alpha > 127
    mask = Image.fromarray((mask_bool * 255).astype(np.uint8), "L")
    thumb = canvas.copy()
    thumb.thumbnail((THUMB, THUMB), Image.LANCZOS)

    warnings = []
    try:
        anchors = estimate_anchors(mask_bool)
    except AnchorEstimationError as e:
        anchors = None
        warnings.append(f"Anchor points could not be estimated automatically ({e}). Place them manually.")

    rgb = np.array(canvas)[:, :, :3][mask_bool]
    dominant = "#%02x%02x%02x" % tuple(int(v) for v in np.median(rgb, axis=0)) if rgb.size else None
    meta = {
        "canvas": CANVAS,
        "garment_box_px": [offset[0], offset[1], size[0], size[1]],
        "scale_from_cutout": round(scale, 5),
        "dominant_color": dominant,
        "warnings": warnings,
    }
    return GarmentAssets(cutout=cutout, processed=canvas, mask=mask, thumb=thumb, anchors=anchors, meta=meta)


def open_original(path: Path) -> Image.Image:
    try:
        with Image.open(path) as raw:
            img = ImageOps.exif_transpose(raw).convert("RGB")
    except OSError as e:
        raise GarmentProcessingError("The original image could not be read.") from e
    img.thumbnail((MODEL_MAX_SIDE, MODEL_MAX_SIDE), Image.LANCZOS)
    return img


def _segment_safe(img: Image.Image) -> np.ndarray:
    try:
        return _segment(img)
    except Exception as e:  # model/runtime failure: log details, show a generic message
        log.exception("background removal failed")
        raise GarmentProcessingError("Background removal failed. Try again or use a different photo.") from e


def split_stacked(img: Image.Image) -> list[Image.Image]:
    """[front, back] crops when the photo shows two similar shirts one above the other (front on top), else [img]."""
    binary = (_segment_safe(img)[:, :, 3] > 127).astype(np.uint8)
    n, _, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    big = sorted(range(1, n), key=lambda i: -stats[i, cv2.CC_STAT_AREA])[:2]
    if len(big) < 2 or stats[big[1], cv2.CC_STAT_AREA] < 0.5 * stats[big[0], cv2.CC_STAT_AREA]:
        return [img]
    top, bottom = sorted(big, key=lambda i: stats[i, cv2.CC_STAT_TOP])
    top_end = stats[top, cv2.CC_STAT_TOP] + stats[top, cv2.CC_STAT_HEIGHT]
    if top_end >= stats[bottom, cv2.CC_STAT_TOP]:  # side by side or overlapping: not a front/back stack
        return [img]
    cut = (top_end + stats[bottom, cv2.CC_STAT_TOP]) // 2
    return [img.crop((0, 0, img.width, cut)), img.crop((0, cut, img.width, img.height))]


def process_original(path: Path) -> GarmentAssets:
    return process_image(open_original(path))


def process_image(img: Image.Image) -> GarmentAssets:
    t0 = time.perf_counter()
    rgba = _segment_safe(img)
    rgba, warnings, clean_meta = _clean(rgba, np.array(img))
    rgba = _defringe(rgba)
    assets = normalize(Image.fromarray(rgba, "RGBA"))
    assets.meta["warnings"] = warnings + assets.meta["warnings"]
    assets.meta.update(clean_meta)
    assets.meta.update({
        "model": config.REMBG_MODEL,
        "model_input_px": list(img.size),
        "processing_ms": round((time.perf_counter() - t0) * 1000),
    })
    return assets


def rotate(processed: Image.Image, degrees: float) -> GarmentAssets:
    # PIL rotates counter-clockwise; the UI's positive angle means clockwise.
    return normalize(processed.rotate(-degrees, resample=Image.BICUBIC, expand=True))


def crop(processed: Image.Image, rect: dict) -> GarmentAssets:
    """rect: normalized {x, y, w, h} of the region to keep."""
    w, h = processed.size
    x0, y0 = int(rect["x"] * w), int(rect["y"] * h)
    x1, y1 = int((rect["x"] + rect["w"]) * w), int((rect["y"] + rect["h"]) * h)
    keep = Image.new("L", processed.size, 0)
    keep.paste(255, (x0, y0, x1, y1))
    out = processed.copy()
    out.putalpha(Image.fromarray(np.minimum(np.array(processed.getchannel("A")), np.array(keep))))
    return normalize(out)
