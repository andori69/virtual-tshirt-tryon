"""Shirt mesh built from the product photo itself (front cut-out, optional back cut-out).

- Outline: the alpha silhouette, simplified and resampled; interior points on a hex grid; Delaunay triangulation
  keeping only triangles inside the silhouette (constrained by the dense outline points), ~1.5-3k triangles.
- UVs are the photo coordinates themselves, so the print appears exactly as photographed.
- Inflation: depth = k * sqrt(distance to the closed seams), k so front + back shells are ~0.35 x torso width thick.
  Open edges (hem, sleeve cuffs, neck) are excluded from the distance, so the shells part there: the shirt is hollow
  with open hem, cuffs and collar instead of a closed pillow.
- Neck: the front shell gets a crew opening deeper than the back; through it the inside of the back shows.
- Keypoints (shoulder tips, neck points, sleeve ends, armpits, hem corners) for pinning the mesh to the body.
- Back photo: mapped onto the same geometry by an affine fit of mirrored keypoints (seen from behind, the wearer's
  right side is on the photo's right).

All coordinates are fractions (0-1) of the processed square canvas.
"""
import cv2
import numpy as np
from scipy.spatial import Delaunay

S = 256                 # working resolution
TARGET_POINTS = 1250    # ~2 triangles per point -> ~2.4k triangles
THICKNESS = 0.35        # front + back shell thickness at the thickest point / torso width


class MeshError(ValueError):
    pass


def _silhouette(alpha: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Filled mask of the largest blob at S x S, and its outline (N x 2, pixel coords)."""
    a = cv2.resize(alpha, (S, S), interpolation=cv2.INTER_AREA)
    cs, _ = cv2.findContours((a > 127).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        raise MeshError("No garment outline.")
    c = max(cs, key=cv2.contourArea)
    mask = np.zeros((S, S), np.uint8)
    cv2.drawContours(mask, [c], -1, 1, -1)
    return mask, c[:, 0, :].astype(float)


def _resample(poly: np.ndarray, step: float) -> np.ndarray:
    """Closed polygon resampled every `step` px along its length."""
    pts = np.vstack([poly, poly[:1]])
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    t = np.arange(0, cum[-1], step)
    return np.stack([np.interp(t, cum, pts[:, 0]), np.interp(t, cum, pts[:, 1])], 1)


def _armpit(outline: np.ndarray, tip: np.ndarray, hem: np.ndarray) -> np.ndarray:
    """Deepest concave point of the outline on the lower path between a sleeve tip and a hem corner."""
    i, j = (int(np.argmin(np.linalg.norm(outline - p, axis=1))) for p in (tip, hem))
    n = len(outline)
    a = [outline[(i + k) % n] for k in range((j - i) % n + 1)]
    b = [outline[(j + k) % n] for k in range((i - j) % n + 1)]
    path = np.array(a if np.mean([p[1] for p in a]) > np.mean([p[1] for p in b]) else b)  # the lower route
    d = hem - tip
    nrm = np.array([-d[1], d[0]]) / (np.linalg.norm(d) or 1)
    dist = (path - tip) @ nrm
    centre = np.array([S / 2, S / 2])
    if (centre - tip) @ nrm < 0:  # measure toward the body centre
        dist = -dist
    return path[int(np.argmax(dist))]


def build_mesh(front_rgba: np.ndarray, anchors: dict, back_rgba: np.ndarray | None = None,
               back_anchors: dict | None = None) -> dict:
    mask, outline = _silhouette(front_rgba[:, :, 3])
    P = lambda k: np.array([anchors[k]["x"], anchors[k]["y"]]) * S
    ls, rs, neck = P("left_shoulder"), P("right_shoulder"), P("neckline_center")
    lsl, rsl, lh, rh, bc = P("left_sleeve"), P("right_sleeve"), P("left_hem"), P("right_hem"), P("bottom_center")
    area = float(mask.sum())
    h = np.sqrt(area / (0.866 * TARGET_POINTS))

    # Outline (simplified, then resampled) + crew opening of the front + hex-grid interior.
    simple = cv2.approxPolyDP(outline.astype(np.float32).reshape(-1, 1, 2), 0.7, True)[:, 0, :].astype(float)
    boundary = _resample(simple, h)
    nh = 0.19 * (rs[0] - ls[0])                         # half-width of the neck opening
    neck_c, neck_ry = np.array([neck[0], neck[1]]), 0.85 * nh   # front opening: ellipse hanging from the collar top
    ang = np.linspace(0, np.pi, max(8, int(np.pi * nh / h)))
    hole = np.stack([neck_c[0] + nh * 0.95 * np.cos(ang), neck_c[1] + neck_ry * np.sin(ang)], 1)
    hole = hole[mask[np.clip(hole[:, 1].astype(int), 0, S - 1), np.clip(hole[:, 0].astype(int), 0, S - 1)] > 0]
    inside = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    gy, gx = np.mgrid[0:S:h * 0.866, 0:S:h]
    gx = gx + (np.arange(gx.shape[0])[:, None] % 2) * h / 2
    grid = np.stack([gx.ravel(), gy.ravel()], 1)
    gi = np.clip(grid.astype(int), 0, S - 1)
    grid = grid[inside[gi[:, 1], gi[:, 0]] > 0.6 * h]
    if len(hole):
        far = np.min(np.linalg.norm(grid[:, None] - hole[None], axis=2), axis=1) > 0.5 * h
        grid = grid[far]
    pts = np.vstack([boundary, hole, grid])
    nb = len(boundary)

    # Delaunay, keeping triangles whose centre and edge midpoints are inside the silhouette.
    tri = Delaunay(pts).simplices
    grown = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    def inside_pt(p):
        q = np.clip(np.rint(p).astype(int), 0, S - 1)
        return grown[q[..., 1], q[..., 0]] > 0
    a, b, c = pts[tri[:, 0]], pts[tri[:, 1]], pts[tri[:, 2]]
    keep = inside_pt((a + b + c) / 3) & inside_pt((a + b) / 2) & inside_pt((b + c) / 2) & inside_pt((c + a) / 2)
    tris = tri[keep]
    if not 1000 <= len(tris) <= 4000:
        raise MeshError(f"Unexpected triangle count {len(tris)}.")

    # Open edges: hem, sleeve cuffs, collar. Everything else on the outline is a closed seam.
    bx, by = boundary[:, 0], boundary[:, 1]
    is_open = (by > bc[1] - 0.015 * S) & (bx > lh[0] - 0.02 * S) & (bx < rh[0] + 0.02 * S)
    for sh, tip in ((ls, lsl), (rs, rsl)):
        # Cuff: the outline at the far end of the sleeve, i.e. no more than 0.035 back from the tip along the sleeve.
        axis = (tip - sh) / (np.linalg.norm(tip - sh) or 1)
        is_open |= ((boundary - tip) @ axis > -0.035 * S) & (np.linalg.norm(boundary - tip, axis=1) < 0.2 * S)
    is_open |= ((bx - neck_c[0]) / nh) ** 2 + ((by - neck_c[1]) / (0.8 * nh)) ** 2 < 1
    seams = np.ones((S, S), np.uint8)
    for k in range(nb):
        if not is_open[k] and not is_open[(k + 1) % nb]:
            cv2.line(seams, tuple(np.rint(boundary[k]).astype(int)), tuple(np.rint(boundary[(k + 1) % nb]).astype(int)), 0, 1)
    dist = cv2.distanceTransform(seams, cv2.DIST_L2, 5)
    pi = np.clip(np.rint(pts).astype(int), 0, S - 1)
    d = dist[pi[:, 1], pi[:, 0]]
    d[:nb][~is_open] = 0
    # Normalise at the chest centre and cap there: open edges (hem, wide cuffs) are far from any seam, and letting them
    # set the scale would flatten the chest.
    torso_w = rh[0] - lh[0]
    chest = np.array([(lh[0] + rh[0]) / 2, ls[1] + 0.3 * (bc[1] - ls[1])]).round().astype(int)
    d_chest = max(float(dist[chest[1], chest[0]]), 1.0)
    k = (THICKNESS / 2) * torso_w / np.sqrt(d_chest)
    depth = k * np.sqrt(np.minimum(d, d_chest))

    # Front shell without the crew opening; the back shell keeps everything (its collar is higher).
    centre = pts[tris].mean(axis=1)
    in_hole = ((centre[:, 0] - neck_c[0]) / (0.95 * nh)) ** 2 + ((centre[:, 1] - neck_c[1]) / neck_ry) ** 2 < 1
    tris_front = tris[~in_hole]

    # Keypoints.
    def top_at(x):
        ys = np.flatnonzero(mask[:, int(np.clip(x, 0, S - 1))])
        return ys[0] if ys.size else neck[1]
    kp = {
        "shoulder_l": ls, "shoulder_r": rs,
        "neck_l": np.array([neck[0] - nh, top_at(neck[0] - nh)]), "neck_r": np.array([neck[0] + nh, top_at(neck[0] + nh)]),
        "sleeve_l": lsl, "sleeve_r": rsl,
        "armpit_l": _armpit(outline, lsl, lh), "armpit_r": _armpit(outline, rsl, rh),
        "hem_l": lh, "hem_r": rh, "hem_c": bc,
    }

    # Sleeve weights: how far each point lies beyond the armhole line (shoulder tip -> armpit), softened over a band.
    def sleeve_w(tip_shoulder, pit, outward_x):
        dvec = pit - tip_shoulder
        nrm = np.array([-dvec[1], dvec[0]]) / (np.linalg.norm(dvec) or 1)
        if nrm[0] * outward_x < 0:
            nrm = -nrm
        s = (pts - tip_shoulder) @ nrm
        return np.clip(s / (0.06 * S) + 0.5, 0, 1)
    wl, wr = sleeve_w(ls, kp["armpit_l"], -1), sleeve_w(rs, kp["armpit_r"], 1)

    uv_back = None
    if back_rgba is not None and back_anchors:
        B = lambda k: np.array([back_anchors[k]["x"], back_anchors[k]["y"]]) * S
        pairs = [("left_shoulder", "right_shoulder"), ("right_shoulder", "left_shoulder"), ("left_sleeve", "right_sleeve"),
                 ("right_sleeve", "left_sleeve"), ("left_hem", "right_hem"), ("right_hem", "left_hem"),
                 ("neckline_center", "neckline_center"), ("bottom_center", "bottom_center")]
        src = np.array([[*P(f), 1] for f, _ in pairs])
        dst = np.array([B(b) for _, b in pairs])
        A, *_ = np.linalg.lstsq(src, dst, rcond=None)
        uv_back = np.hstack([pts, np.ones((len(pts), 1))]) @ A

    r = lambda v: np.round(np.asarray(v, float) / S, 4).ravel().tolist()
    return {
        "uv": r(pts), "depth": r(depth), "sleeveL": np.round(wl, 3).tolist(), "sleeveR": np.round(wr, 3).tolist(),
        "boundary": nb, "open": is_open.astype(int).tolist(),
        "trisFront": tris_front.ravel().tolist(), "trisBack": tris.ravel().tolist(),
        "uvBack": r(uv_back) if uv_back is not None else None,
        "keypoints": {k: r(v) for k, v in kp.items()},
        "neck": {"x": round(neck_c[0] / S, 4), "y": round(neck_c[1] / S, 4), "halfW": round(nh / S, 4)},
    }
