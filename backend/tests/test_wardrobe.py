import io
import json

import numpy as np
from PIL import Image, ImageDraw

from app import wardrobe
from app.image_processing import pipeline
from app.image_processing.attributes import color_name, extract_attributes
from app.sample_data import sample_tee_photo


def test_labels_from_filenames():
    assert wardrobe.label_for("good_things-take_time.jpg") == "Good Things Take Time"
    assert wardrobe.label_for("  black__tee .png") == "Black Tee"
    assert wardrobe.label_for("1.jpg") == "1"


def test_scan_processes_caches_and_never_touches_originals(client):
    d = wardrobe.WARDROBE_DIR
    tee = sample_tee_photo((34, 48, 79), seed=1)
    (d / "navy_crew-tee.jpg").write_bytes(tee)
    (d / "broken.png").write_bytes(b"not an image")
    (d / ".hidden.jpg").write_bytes(tee)
    (d / "notes.txt").write_text("ignore me")

    items = client.get("/api/wardrobe").json()
    assert [i["file"] for i in items] == ["broken.png", "navy_crew-tee.jpg"]
    wardrobe.wait_idle()
    items = {i["file"]: i for i in client.get("/api/wardrobe").json()}

    ok = items["navy_crew-tee.jpg"]
    assert ok["status"] == "ready" and ok["label"] == "Navy Crew Tee"
    assert ok["attributes"]["base_color_name"] == "navy"
    assert ok["attributes"]["sleeve_length"] == "short"
    assert ok["attributes"]["print"]["has_print"] is False
    assert set(ok["anchors"]) >= {"left_shoulder", "right_shoulder", "bottom_center"}
    assert client.get(ok["garment_url"]).headers["content-type"] == "image/png"
    assert client.get(ok["thumb_url"]).status_code == 200
    meta = json.loads((d / ".cache" / f"{ok['id']}.json").read_text())
    assert meta["status"] == "ready" and meta["source_file"] == "navy_crew-tee.jpg"

    bad = items["broken.png"]
    assert bad["status"] == "failed" and "readable" in bad["error"] and bad["garment_url"] is None

    # Originals untouched; nothing written outside .cache.
    assert (d / "navy_crew-tee.jpg").read_bytes() == tee
    assert sorted(p.name for p in d.iterdir()) == [".cache", ".hidden.jpg", "broken.png", "navy_crew-tee.jpg", "notes.txt"]

    # A newly dropped file shows up on the next scan without code changes; a rename reuses the cache.
    (d / "brick_tee.webp").write_bytes(_to_webp(sample_tee_photo((165, 67, 47), seed=2)))
    (d / "navy_crew-tee.jpg").rename(d / "navy-renamed.jpg")
    items = {i["file"]: i for i in client.get("/api/wardrobe").json()}
    assert items["brick_tee.webp"]["status"] == "processing"
    assert items["navy-renamed.jpg"]["status"] == "ready" and items["navy-renamed.jpg"]["id"] == ok["id"]
    wardrobe.wait_idle()
    assert {i["file"]: i["status"] for i in client.get("/api/wardrobe").json()}["brick_tee.webp"] == "ready"


def test_wardrobe_asset_route_rejects_bad_keys(client):
    assert client.get("/api/wardrobe/../../secret/garment.png").status_code == 404
    assert client.get("/api/wardrobe/zzzz/garment.png").status_code == 404
    assert client.get("/api/wardrobe/0123456789abcdef/original.png").status_code == 404


def _to_webp(jpg: bytes) -> bytes:
    buf = io.BytesIO()
    Image.open(io.BytesIO(jpg)).save(buf, format="WEBP")
    return buf.getvalue()


def test_print_detection():
    photo = Image.open(io.BytesIO(sample_tee_photo((20, 20, 22), seed=3)))
    ImageDraw.Draw(photo).rectangle((380, 380, 620, 600), fill=(250, 250, 250))  # white chest print
    buf = io.BytesIO()
    photo.save(buf, format="PNG")
    path = wardrobe.WARDROBE_DIR / ".cache"
    path.mkdir(exist_ok=True)
    f = path / "print-test.png"
    f.write_bytes(buf.getvalue())
    a = pipeline.process_original(f)
    attrs = extract_attributes(np.array(a.processed), a.anchors)
    assert attrs["base_color_name"] == "black"
    assert attrs["print"]["has_print"] and attrs["print"]["color_name"] == "white"
    x0, y0, x1, y1 = attrs["print"]["bbox"]
    assert 0.3 < (x0 + x1) / 2 < 0.7 and y0 < y1


def test_color_names():
    assert color_name((10, 10, 12)) == "black"
    assert color_name((250, 250, 248)) == "white"
    assert color_name((200, 30, 40)) == "red"


def test_front_back_stack_is_split(client):
    # One photo with the front above the back (how the shop's own shirt photos are laid out).
    front = Image.open(io.BytesIO(sample_tee_photo((120, 30, 35), seed=4))).convert("RGB")
    back = Image.open(io.BytesIO(sample_tee_photo((120, 30, 35), seed=5))).convert("RGB")
    ImageDraw.Draw(back).rectangle((380, 300, 620, 420), fill=(240, 240, 240))  # back-only print
    stack = Image.new("RGB", (front.width, front.height + back.height))
    stack.paste(front, (0, 0))
    stack.paste(back, (0, front.height))
    parts = pipeline.split_stacked(stack)
    assert len(parts) == 2 and parts[0].height + parts[1].height == stack.height
    assert pipeline.split_stacked(front) == [front]

    buf = io.BytesIO()
    stack.save(buf, format="PNG")
    (wardrobe.WARDROBE_DIR / "maroon.png").write_bytes(buf.getvalue())
    client.get("/api/wardrobe")
    wardrobe.wait_idle()
    item = next(i for i in client.get("/api/wardrobe").json() if i["file"] == "maroon.png")
    assert item["status"] == "ready" and item["back_url"]
    back_png = Image.open(io.BytesIO(client.get(item["back_url"]).content))
    assert back_png.mode == "RGBA"
    assert extract_attributes(np.array(back_png), None)["print"]["has_print"]
    # A single-shirt photo has no back view.
    (wardrobe.WARDROBE_DIR / "maroon.png").unlink()
    (wardrobe.WARDROBE_DIR / "plain.jpg").write_bytes(sample_tee_photo((34, 48, 79), seed=6))
    client.get("/api/wardrobe")
    wardrobe.wait_idle()
    assert next(i for i in client.get("/api/wardrobe").json() if i["file"] == "plain.jpg")["back_url"] is None


def test_cutout_edges_carry_no_background_colour():
    # Cream shirt shot on black: the cut-out's edge must not keep a dark outline.
    photo = Image.open(io.BytesIO(sample_tee_photo((238, 220, 198), background=(12, 12, 12), seed=7))).convert("RGB")
    a = pipeline.process_image(photo)
    rgba = np.array(a.processed)
    alpha = rgba[:, :, 3]
    solid = alpha > 250
    import cv2
    edge = (alpha > 30) & ~cv2.erode(solid.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    lum = rgba[:, :, :3].astype(float).mean(axis=2)
    assert edge.sum() > 100
    assert lum[edge].mean() > 0.85 * lum[solid].mean()


def test_cutout_edges_carry_no_background_colour():
    # Cream shirt shot on black: the cut-out's edge must not keep a dark outline, and must stay soft (feathered).
    import cv2
    photo = Image.open(io.BytesIO(sample_tee_photo((238, 220, 198), background=(12, 12, 12), seed=7))).convert("RGB")
    rgba = np.array(pipeline.process_image(photo).processed)
    alpha = rgba[:, :, 3]
    solid = alpha > 250
    edge = (alpha > 30) & ~cv2.erode(solid.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    lum = rgba[:, :, :3].astype(float).mean(axis=2)
    assert edge.sum() > 100
    assert lum[edge].mean() > 0.85 * lum[solid].mean()
    assert ((alpha > 0) & (alpha < 255)).sum() > 0.5 * edge.sum()  # partial-alpha pixels exist along the outline
