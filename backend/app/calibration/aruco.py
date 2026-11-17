"""ArUco marker detection -> approximate pixel-per-centimetre scale at the marker's depth plane."""
import io

import cv2
import numpy as np
from PIL import Image, ImageOps

DICTIONARY_NAME = "DICT_4X4_50"
_DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
_DETECTOR = cv2.aruco.ArucoDetector(_DICT, cv2.aruco.DetectorParameters())
MAX_SKEW = 1.15  # longest/shortest side; above this the marker is too tilted for a usable scale


class CalibrationError(ValueError):
    pass


def marker_png(marker_id: int = 0, side_px: int = 800) -> bytes:
    marker = cv2.aruco.generateImageMarker(_DICT, marker_id, side_px)
    border = side_px // 8  # white quiet zone needed for detection
    marker = cv2.copyMakeBorder(marker, border, border, border, border, cv2.BORDER_CONSTANT, value=255)
    ok, buf = cv2.imencode(".png", marker)
    assert ok
    return buf.tobytes()


def detect(image_bytes: bytes, marker_size_cm: float, marker_id: int | None = None) -> dict:
    if not (1 <= marker_size_cm <= 100):
        raise CalibrationError("Marker size must be between 1 and 100 cm.")
    try:
        with Image.open(io.BytesIO(image_bytes)) as raw:
            img = np.array(ImageOps.exif_transpose(raw).convert("L"))
    except OSError:
        raise CalibrationError("The calibration frame could not be decoded.")
    corners, ids, _ = _DETECTOR.detectMarkers(img)
    if ids is None or len(ids) == 0:
        raise CalibrationError(
            "No ArUco marker found. Hold the printed marker flat, fully visible, well lit, facing the camera."
        )
    ids = ids.flatten().tolist()
    idx = ids.index(marker_id) if marker_id is not None and marker_id in ids else 0
    if marker_id is not None and marker_id not in ids:
        raise CalibrationError(f"Marker id {marker_id} not found (found {ids}).")
    pts = corners[idx].reshape(4, 2).astype(float)
    sides = [float(np.linalg.norm(pts[i] - pts[(i + 1) % 4])) for i in range(4)]
    side_px = float(np.mean(sides))
    skew = max(sides) / min(sides)
    if skew > MAX_SKEW:
        raise CalibrationError(
            f"The marker is tilted (side ratio {skew:.2f}). Hold it flat and parallel to the camera."
        )
    h, w = img.shape
    return {
        "marker_id": ids[idx],
        "marker_dictionary": DICTIONARY_NAME,
        "corners_px": pts.round(1).tolist(),
        "marker_side_px": round(side_px, 2),
        "px_per_cm": round(side_px / marker_size_cm, 4),
        "skew_ratio": round(skew, 4),
        "frame_width": int(w),
        "frame_height": int(h),
    }
