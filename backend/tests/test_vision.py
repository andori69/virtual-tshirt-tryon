import io

import cv2
import numpy as np
import pytest
from PIL import Image

from app.calibration import aruco
from app.fitting.recommend import BodySample, CalibrationInfo, SizeSpec, ellipse_circumference, recommend
from app.image_processing.anchors import AnchorEstimationError, validate_anchors
from app.services import storage
from app.settings_store import DEFAULTS

RULES = DEFAULTS["fit_rules"]


def _frame_with_marker(side=300, warp=False) -> bytes:
    m = cv2.imdecode(np.frombuffer(aruco.marker_png(0, side), np.uint8), 0)
    frame = np.full((720, 1280), 170, np.uint8)
    frame[100:100 + m.shape[0], 300:300 + m.shape[1]] = m
    if warp:
        src = np.float32([[300, 100], [300 + m.shape[1], 100], [300 + m.shape[1], 100 + m.shape[0]], [300, 100 + m.shape[0]]])
        dst = np.float32([[300, 100], [300 + m.shape[1], 160], [300 + m.shape[1], 40 + m.shape[0]], [300, 100 + m.shape[0]]])
        frame = cv2.warpPerspective(frame, cv2.getPerspectiveTransform(src, dst), (1280, 720), borderValue=170)
    return cv2.imencode(".png", frame)[1].tobytes()


def test_aruco_scale():
    r = aruco.detect(_frame_with_marker(300), marker_size_cm=15)
    assert abs(r["marker_side_px"] - 300) < 3
    assert abs(r["px_per_cm"] - 20) < 0.2
    assert (r["frame_width"], r["frame_height"]) == (1280, 720)


def test_aruco_no_marker_and_tilt():
    blank = cv2.imencode(".png", np.full((480, 640), 128, np.uint8))[1].tobytes()
    with pytest.raises(aruco.CalibrationError, match="No ArUco marker"):
        aruco.detect(blank, 10)
    with pytest.raises(aruco.CalibrationError, match="tilted"):
        aruco.detect(_frame_with_marker(300, warp=True), 10)
    with pytest.raises(aruco.CalibrationError):
        aruco.detect(_frame_with_marker(), 0)


def test_calibration_api_saves_active(owner_client, client):
    files = {"file": ("f.png", _frame_with_marker(300), "image/png")}
    r = owner_client.post("/api/owner/calibration", files=files, data={"marker_size_cm": "15", "camera_label": "cam"})
    assert r.status_code == 200 and abs(r.json()["active"]["px_per_cm"] - 20) < 0.2
    assert abs(client.get("/api/kiosk/config").json()["calibration"]["px_per_cm"] - 20) < 0.2
    r = owner_client.post("/api/owner/calibration/detect",
                          files={"file": ("f.png", cv2.imencode(".png", np.zeros((100, 100), np.uint8))[1].tobytes())},
                          data={"marker_size_cm": "10"})
    assert r.status_code == 422
    assert owner_client.get("/api/owner/calibration/marker.png").headers["content-type"] == "image/png"
    owner_client.delete("/api/owner/calibration")
    assert client.get("/api/kiosk/config").json()["calibration"] is None


def test_anchor_validation():
    good = {k: {"x": 0.5, "y": 0.5} for k in ("neckline_center", "left_sleeve", "right_sleeve", "left_hem", "right_hem")}
    good |= {"left_shoulder": {"x": 0.3, "y": 0.1}, "right_shoulder": {"x": 0.7, "y": 0.1},
             "neckline_center": {"x": 0.5, "y": 0.12}, "bottom_center": {"x": 0.5, "y": 0.95}}
    assert validate_anchors(good)["left_shoulder"] == {"x": 0.3, "y": 0.1}
    with pytest.raises(AnchorEstimationError):
        validate_anchors({**good, "left_shoulder": {"x": 1.5, "y": 0.1}})


def test_storage_blocks_path_traversal():
    with pytest.raises(ValueError):
        storage.abs_path("../../etc/passwd")
    with pytest.raises(ValueError):
        storage.abs_path("/etc/passwd")


# ---- recommendation ----

SIZES = [SizeSpec("S", 48, 42, 66), SizeSpec("M", 51, 44, 69), SizeSpec("L", 54, 46, 72), SizeSpec("XL", 57, 48, 75, in_stock=False)]
CAL = CalibrationInfo(px_per_cm=5.0, frame_width=1280, frame_height=720)


def body(chest_cm=None, shoulder_cm=40.0, **kw):
    # Inverse of the model so tests read in centimetres.
    return BodySample(
        shoulder_span_px=shoulder_cm / RULES["shoulder_landmark_factor"] * 5.0,
        chest_width_px=chest_cm * 5.0 if chest_cm else None,
        frame_width=1280, frame_height=720, visibility=0.95, stability_cv=0.01, samples=30, **kw,
    )


def test_ellipse_circumference_circle():
    assert ellipse_circumference(10, 10) == pytest.approx(np.pi * 10, rel=1e-6)


def test_no_calibration_is_insufficient():
    r = recommend(body(32), SIZES, None, RULES)
    assert r["status"] == "insufficient" and "calibrated" in r["reason"]


def test_too_few_samples_is_insufficient():
    b = body(32)
    b.samples = 2
    assert recommend(b, SIZES, CAL, RULES)["status"] == "insufficient"


def test_bigger_body_gets_bigger_size_and_fits_are_monotonic():
    small = recommend(body(30), SIZES, CAL, RULES)
    large = recommend(body(35), SIZES, CAL, RULES)
    order = ["S", "M", "L", "XL"]
    assert small["status"] == large["status"] == "ok"
    assert order.index(large["recommended"]) > order.index(small["recommended"])
    eases = [s["chest_ease_cm"] for s in small["sizes"]]
    assert eases == sorted(eases)
    fits = [s["fit"] for s in small["sizes"]]
    rank = ["tight", "regular", "relaxed", "oversized"]
    assert [rank.index(f) for f in fits] == sorted(rank.index(f) for f in fits)


def test_recommended_size_hits_preferred_band():
    r = recommend(body(32), SIZES, CAL, RULES)
    rec = next(s for s in r["sizes"] if s["label"] == r["recommended"])
    assert rec["fit"] == "regular"
    assert RULES["ease_tight_max_cm"] <= rec["chest_ease_cm"] < RULES["ease_regular_max_cm"]


def test_out_of_stock_recommendation_suggests_available():
    r = recommend(body(39), SIZES, CAL, RULES)
    assert r["recommended"] == "XL" and r["recommended_available"] == "L"
    assert "out of stock" in r["explanation"]


def test_shoulder_only_fallback_has_lower_confidence():
    with_chest = recommend(body(32), SIZES, CAL, RULES)
    shoulder_only = recommend(body(None), SIZES, CAL, RULES)
    assert shoulder_only["status"] == "ok"
    assert shoulder_only["confidence"] < with_chest["confidence"]
    assert all(s["chest_ease_cm"] is None for s in shoulder_only["sizes"])


def test_low_visibility_refuses():
    b = body(32)
    b.visibility = 0.2
    r = recommend(b, SIZES, CAL, RULES)
    assert r["status"] == "insufficient" and "confidence" in r["reason"]


def test_resolution_scaling():
    # Same scene captured at half resolution must give the same body estimate.
    full = recommend(body(32), SIZES, CAL, RULES)
    b = body(32)
    b.shoulder_span_px /= 2
    b.chest_width_px /= 2
    b.frame_width, b.frame_height = 640, 360
    half = recommend(b, SIZES, CAL, RULES)
    assert half["body_estimate"] == full["body_estimate"]


def test_preferred_fit_is_configurable():
    relaxed = recommend(body(32), SIZES, CAL, {**RULES, "preferred_fit": "relaxed"})
    regular = recommend(body(32), SIZES, CAL, RULES)
    order = ["S", "M", "L", "XL"]
    assert order.index(relaxed["recommended"]) >= order.index(regular["recommended"])


def test_recommend_api(owner_client, client):
    from .test_products import ready_product

    p = ready_product(owner_client)
    owner_client.post(f"/api/owner/products/{p['id']}/publish")
    owner_client.post("/api/owner/calibration", files={"file": ("f.png", _frame_with_marker(300), "image/png")},
                      data={"marker_size_cm": "15"})
    payload = {"product_id": p["id"], "variant_id": p["variants"][0]["id"],
               "body": {"shoulder_span_px": 600, "chest_width_px": 640, "frame_width": 1280, "frame_height": 720,
                        "visibility": 0.9, "stability_cv": 0.01, "samples": 30}}
    r = client.post("/api/fitting/recommend", json=payload)
    assert r.status_code == 200 and r.json()["status"] == "ok"
    sizes = {s["label"]: s for s in r.json()["sizes"]}
    assert sizes["M"]["in_stock"] is False  # stock M = 0 in ready_product
    bad = {**payload, "body": {**payload["body"], "shoulder_span_px": -1}}
    assert client.post("/api/fitting/recommend", json=bad).status_code == 422


def test_settings_validation(owner_client):
    s = owner_client.get("/api/owner/settings").json()
    rules = {**s["fit_rules"], "ease_tight_max_cm": 30}
    assert owner_client.put("/api/owner/settings/fit_rules", json=rules).status_code == 422
    assert owner_client.put("/api/owner/settings/nope", json={}).status_code == 404
    store = {**s["store"], "low_stock_threshold": 5}
    assert owner_client.put("/api/owner/settings/store", json=store).json()["low_stock_threshold"] == 5
    owner_client.put("/api/owner/settings/store", json=s["store"])
