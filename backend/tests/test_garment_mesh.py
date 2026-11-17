import io

import numpy as np
from PIL import Image

from app.image_processing import pipeline
from app.image_processing.garment_mesh import build_mesh
from app.sample_data import sample_tee_photo


def _tee(seed=1):
    a = pipeline.process_image(Image.open(io.BytesIO(sample_tee_photo((34, 48, 79), seed=seed))).convert("RGB"))
    return np.array(a.processed), a.anchors


def test_mesh_from_photo():
    rgba, an = _tee()
    m = build_mesh(rgba, an, rgba, an)
    uv = np.array(m["uv"]).reshape(-1, 2)
    tb, tf = np.array(m["trisBack"]).reshape(-1, 3), np.array(m["trisFront"]).reshape(-1, 3)
    assert 1500 <= len(tb) <= 3000
    assert len(tf) < len(tb)                                  # front shell has the crew opening
    # Every triangle centre lies on the garment (alpha), i.e. the outline is respected.
    alpha = rgba[:, :, 3]
    c = (uv[tb].mean(axis=1) * (alpha.shape[0] - 1)).round().astype(int)
    assert (alpha[c[:, 1], c[:, 0]] > 0).mean() > 0.99
    # Inflation: thickest point ~0.35 x torso width in total; closed seams at zero, the open hem stays apart.
    depth = np.array(m["depth"])
    torso_w = an["right_hem"]["x"] - an["left_hem"]["x"]
    assert abs(2 * depth.max() / torso_w - 0.35) < 0.02
    i_chest = int(np.argmin(np.linalg.norm(uv - [0.5, an["left_shoulder"]["y"] + 0.3 * (an["bottom_center"]["y"] - an["left_shoulder"]["y"])], axis=1)))
    assert depth[i_chest] > 0.9 * depth.max()                 # the chest is the thickest part, not the open hem
    nb, opened = m["boundary"], np.array(m["open"], bool)
    assert np.all(depth[:nb][~opened] == 0)
    hem = (uv[:nb, 1] > an["bottom_center"]["y"] - 0.01) & opened
    assert depth[:nb][hem].max() > 0.3 * depth.max()
    # Keypoints in sensible places; the armpit sits between shoulder and hem, inside the sleeve tip.
    k = {n: np.array(v) for n, v in m["keypoints"].items()}
    assert k["shoulder_l"][1] < k["armpit_l"][1] < k["hem_l"][1]
    assert k["sleeve_l"][0] < k["armpit_l"][0] < k["neck_l"][0] < k["neck_r"][0] < k["armpit_r"][0] < k["sleeve_r"][0]
    # Sleeve weights: 1 at the sleeve tips, 0 at the chest centre.
    i_tip = int(np.argmin(np.linalg.norm(uv - k["sleeve_l"], axis=1)))
    i_mid = int(np.argmin(np.linalg.norm(uv - np.array([0.5, 0.5]), axis=1)))
    assert m["sleeveL"][i_tip] == 1 and m["sleeveL"][i_mid] == 0 and m["sleeveR"][i_mid] == 0
    # Back photo seen from behind: the front's left shoulder lands on the back photo's right shoulder.
    ub = np.array(m["uvBack"]).reshape(-1, 2)
    i_ls = int(np.argmin(np.linalg.norm(uv - k["shoulder_l"], axis=1)))
    assert np.linalg.norm(ub[i_ls] - [an["right_shoulder"]["x"], an["right_shoulder"]["y"]]) < 0.03


def test_mesh_without_back():
    rgba, an = _tee(2)
    assert build_mesh(rgba, an)["uvBack"] is None


def test_whole_cuff_is_open():
    rgba, an = _tee(3)
    m = build_mesh(rgba, an)
    uv = np.array(m["uv"]).reshape(-1, 2)[: m["boundary"]]
    opened = np.array(m["open"], bool)
    tip = np.array([an["left_sleeve"]["x"], an["left_sleeve"]["y"]])
    near = np.linalg.norm(uv - tip, axis=1) < 0.025
    assert near.any() and opened[near].all()


def test_side_seams_and_shoulders_stay_closed():
    rgba, an = _tee(4)
    m = build_mesh(rgba, an)
    uv = np.array(m["uv"]).reshape(-1, 2)[: m["boundary"]]
    opened = np.array(m["open"], bool)
    k = {n: np.array(v) for n, v in m["keypoints"].items()}
    near = lambda p: np.linalg.norm(uv - p, axis=1) <= np.linalg.norm(uv - p, axis=1).min() + 0.01
    side = near((k["armpit_l"] + k["hem_l"]) / 2)
    shoulder = near((k["shoulder_l"] + k["neck_l"]) / 2)
    assert side.any() and not opened[side].any()
    assert shoulder.any() and not opened[shoulder].any()
    assert opened.mean() < 0.45
