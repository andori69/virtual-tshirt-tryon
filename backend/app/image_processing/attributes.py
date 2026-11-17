"""Local garment attribute extraction: base color, print, sleeve length, neckline. All estimates, labelled as such."""
import cv2
import numpy as np

# Small named palette (sRGB). Nearest in Lab wins.
PALETTE = {
    "black": (20, 20, 22), "charcoal": (60, 62, 66), "gray": (128, 128, 130), "light gray": (200, 200, 200),
    "white": (245, 245, 242), "cream": (240, 228, 200), "beige": (215, 195, 160), "brown": (110, 70, 45),
    "navy": (30, 40, 80), "blue": (40, 90, 190), "sky blue": (130, 185, 230), "teal": (20, 120, 120),
    "green": (40, 130, 60), "forest": (45, 90, 65), "olive": (110, 115, 55), "yellow": (240, 210, 60),
    "mustard": (200, 160, 40), "orange": (235, 120, 40), "red": (200, 35, 40), "maroon": (110, 25, 40),
    "pink": (240, 160, 190), "purple": (110, 60, 150), "lavender": (190, 170, 220),
}


def _lab(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(float)


_PAL_NAMES = list(PALETTE)
_PAL_LAB = _lab(np.array([PALETTE[n] for n in _PAL_NAMES]))


def color_name(rgb) -> str:
    d = np.linalg.norm(_PAL_LAB - _lab(np.array([rgb]))[0], axis=1)
    return _PAL_NAMES[int(np.argmin(d))]


def extract_attributes(rgba: np.ndarray, anchors: dict | None) -> dict:
    """rgba: processed garment canvas (HxWx4). anchors: normalized garment anchors or None."""
    h, w = rgba.shape[:2]
    alpha = rgba[:, :, 3] > 127
    px = rgba[:, :, :3][alpha]
    if px.size == 0:
        return {}
    lab = _lab(px)

    # Base fabric = largest cluster; print = pixels far from it.
    k = min(3, len(lab))
    _, labels, centers = cv2.kmeans(lab.astype(np.float32), k, None,
                                    (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 0.5), 3, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.ravel(), minlength=k)
    base = int(np.argmax(counts))
    base_rgb = np.median(px[labels.ravel() == base], axis=0)
    dist = np.linalg.norm(lab - centers[base], axis=1)
    is_print = dist > 25

    print_mask = np.zeros((h, w), bool)
    print_mask[alpha] = is_print
    # Ignore thin seams/edges: keep print blobs that survive an opening.
    print_mask = cv2.morphologyEx(print_mask.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)).astype(bool)
    coverage = float(print_mask.sum()) / max(1, int(alpha.sum()))
    attrs: dict = {
        "base_color_hex": "#%02x%02x%02x" % tuple(int(v) for v in base_rgb),
        "base_color_name": color_name(base_rgb),
        "print": {"has_print": coverage > 0.02, "coverage": round(coverage, 3)},
    }
    if coverage > 0.02:
        ys, xs = np.nonzero(print_mask)
        attrs["print"]["bbox"] = [round(xs.min() / w, 3), round(ys.min() / h, 3), round(xs.max() / w, 3), round(ys.max() / h, 3)]
        attrs["print"]["color_hex"] = "#%02x%02x%02x" % tuple(int(v) for v in np.median(rgba[:, :, :3][print_mask], axis=0))
        attrs["print"]["color_name"] = color_name(np.median(rgba[:, :, :3][print_mask], axis=0))

    if anchors:
        attrs["sleeve_length"] = _sleeve_length(anchors)
        attrs["neckline"] = _neckline(alpha, anchors)
    return attrs


def _sleeve_length(a: dict) -> str:
    span = a["right_shoulder"]["x"] - a["left_shoulder"]["x"]
    body = a["bottom_center"]["y"] - (a["left_shoulder"]["y"] + a["right_shoulder"]["y"]) / 2
    reach = np.mean([
        np.hypot(a["left_sleeve"]["x"] - a["left_shoulder"]["x"], a["left_sleeve"]["y"] - a["left_shoulder"]["y"]),
        np.hypot(a["right_sleeve"]["x"] - a["right_shoulder"]["x"], a["right_sleeve"]["y"] - a["right_shoulder"]["y"]),
    ])
    outward = (a["right_sleeve"]["x"] - a["left_sleeve"]["x"] - span) / 2
    if outward < 0.04 and reach < 0.12 * body:  # outline barely extends past the shoulders
        return "sleeveless"
    return "long" if reach > 0.62 * body else "short"


def _neckline(alpha: np.ndarray, a: dict) -> str:
    h, w = alpha.shape
    nx, ny = int(a["neckline_center"]["x"] * (w - 1)), int(a["neckline_center"]["y"] * (h - 1))
    span = (a["right_shoulder"]["x"] - a["left_shoulder"]["x"]) * w
    tops = []
    for x in range(int(nx - 0.3 * span), int(nx + 0.3 * span)):
        col = np.flatnonzero(alpha[:, max(0, min(w - 1, x))])
        tops.append(col[0] if col.size else ny)
    tops = np.array(tops)
    collar_top = tops.min()
    depth = (ny - collar_top) / max(span, 1)
    if depth < 0.06:
        return "high crew"
    # A V-neck's top contour is straight lines into a point; a round neck stays deep across its middle.
    q = len(tops) // 4
    mid = len(tops) // 2
    quarter_depth = (np.mean([tops[mid - q // 2], tops[mid + q // 2]]) - collar_top) / max(ny - collar_top, 1)
    if depth > 0.18 and quarter_depth < 0.6:
        return "v-neck"
    return "scoop" if depth > 0.22 else "crew"
