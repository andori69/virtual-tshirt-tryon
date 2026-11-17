import pytest

from app import config
from app.sample_data import sample_tee_photo

from .conftest import SIZES, png_bytes


def make_product(c, **kw):
    r = c.post("/api/owner/products", json={"name": "Test Tee", "price": "350.00", **kw})
    assert r.status_code == 201, r.text
    return r.json()


def ready_product(c, stock=None):
    p = make_product(c)
    pid = p["id"]
    assert c.put(f"/api/owner/products/{pid}/sizes", json=SIZES).status_code == 200
    p = c.post(f"/api/owner/products/{pid}/variants", json={"color_name": "Navy", "color_hex": "#22304f"}).json()
    vid = p["variants"][0]["id"]
    r = c.post(f"/api/owner/variants/{vid}/image",
               files={"file": ("tee.jpg", sample_tee_photo((34, 48, 79)), "image/jpeg")})
    assert r.status_code == 200, r.text
    img = r.json()["variants"][0]["image"]
    assert img["status"] == "processed", img
    c.put(f"/api/owner/images/{img['id']}/anchors", json={"anchors": img["anchors"], "confirmed": True})
    c.put(f"/api/owner/variants/{vid}/stock", json={"quantities": stock or {"S": 2, "M": 0, "L": 5}})
    return c.get(f"/api/owner/products/{pid}").json()


def test_create_edit_and_list(owner_client):
    p = make_product(owner_client, brand="B")
    assert p["status"] == "draft" and p["publish_ready"] is False
    r = owner_client.patch(f"/api/owner/products/{p['id']}", json={"price": "420.50", "description": "soft"})
    assert r.json()["price"] == "420.50" and r.json()["description"] == "soft"
    assert any(x["id"] == p["id"] for x in owner_client.get("/api/owner/products").json())


def test_invalid_product_fields(owner_client):
    assert owner_client.post("/api/owner/products", json={"name": ""}).status_code == 422
    assert owner_client.post("/api/owner/products", json={"name": "x", "price": "-1"}).status_code == 422
    assert owner_client.post("/api/owner/products", json={"name": "x", "currency": "pesos"}).status_code == 422


def test_size_measurement_validation(owner_client):
    pid = make_product(owner_client)["id"]
    bad = [{**SIZES[0], "chest_width_cm": -5}]
    r = owner_client.put(f"/api/owner/products/{pid}/sizes", json=bad)
    assert r.status_code == 422 and "chest width" in r.json()["detail"]["problems"][0]
    dup = [SIZES[0], SIZES[0]]
    assert owner_client.put(f"/api/owner/products/{pid}/sizes", json=dup).status_code == 422
    assert owner_client.put(f"/api/owner/products/{pid}/sizes", json=[{**SIZES[0], "label": "XXXL"}]).status_code == 422
    r = owner_client.put(f"/api/owner/products/{pid}/sizes", json=SIZES)
    assert [s["label"] for s in r.json()["sizes"]] == ["S", "M", "L"]


def test_sizes_and_variants_create_inventory(owner_client):
    pid = make_product(owner_client)["id"]
    owner_client.put(f"/api/owner/products/{pid}/sizes", json=SIZES)
    p = owner_client.post(f"/api/owner/products/{pid}/variants", json={"color_name": "Red"}).json()
    assert p["variants"][0]["stock"] == {"S": 0, "M": 0, "L": 0}
    vid = p["variants"][0]["id"]
    assert owner_client.put(f"/api/owner/variants/{vid}/stock", json={"quantities": {"XL": 1}}).status_code == 422
    assert owner_client.put(f"/api/owner/variants/{vid}/stock", json={"quantities": {"S": -1}}).status_code == 422
    p = owner_client.put(f"/api/owner/variants/{vid}/stock", json={"quantities": {"S": 3}}).json()
    assert p["variants"][0]["stock"]["S"] == 3
    # Removing a size removes its stock row; re-adding starts at 0.
    p = owner_client.put(f"/api/owner/products/{pid}/sizes", json=SIZES[1:]).json()
    assert p["variants"][0]["stock"] == {"M": 0, "L": 0}


@pytest.mark.parametrize("data,status", [
    (b"not an image at all", 415),
    (b"", 422),
    (png_bytes((100, 100)), 422),          # too small
    (png_bytes(fmt="GIF"), 415),            # real image, unsupported format
    (png_bytes()[:200], 415),               # truncated PNG
])
def test_upload_validation_by_content(owner_client, data, status):
    pid = make_product(owner_client)["id"]
    vid = owner_client.post(f"/api/owner/products/{pid}/variants", json={"color_name": "X"}).json()["variants"][0]["id"]
    r = owner_client.post(f"/api/owner/variants/{vid}/image", files={"file": ("shirt.png", data, "image/png")})
    assert r.status_code == status, r.text
    assert "detail" in r.json() and "Traceback" not in r.text


def test_upload_too_large(owner_client, monkeypatch):
    monkeypatch.setattr(config, "MAX_UPLOAD_MB", 0.001)
    pid = make_product(owner_client)["id"]
    vid = owner_client.post(f"/api/owner/products/{pid}/variants", json={"color_name": "X"}).json()["variants"][0]["id"]
    r = owner_client.post(f"/api/owner/variants/{vid}/image", files={"file": ("a.png", png_bytes(), "image/png")})
    assert r.status_code == 413


def test_processing_failure_is_reported(owner_client):
    pid = make_product(owner_client)["id"]
    vid = owner_client.post(f"/api/owner/products/{pid}/variants", json={"color_name": "X"}).json()["variants"][0]["id"]
    r = owner_client.post(f"/api/owner/variants/{vid}/image", files={"file": ("blank.png", png_bytes(), "image/png")})
    assert r.status_code == 200
    img = r.json()["variants"][0]["image"]
    assert img["status"] == "failed" and img["error"]
    assert img["processed_url"] is None


def test_full_publish_flow_and_catalog(owner_client, client):
    p = ready_product(owner_client)
    pid = p["id"]
    img = p["variants"][0]["image"]
    # Original kept separately from processed asset.
    assert img["original_url"].endswith("/original") and img["processed_url"].startswith("/assets/processed/")
    assert owner_client.get(img["original_url"]).status_code == 200
    assert owner_client.get(img["processed_url"]).headers["content-type"] == "image/png"

    # Draft is not visible to customers.
    assert all(x["id"] != pid for x in client.get("/api/catalog").json())
    r = owner_client.post(f"/api/owner/products/{pid}/publish")
    assert r.status_code == 200 and r.json()["status"] == "published"

    entry = next(x for x in client.get("/api/catalog").json() if x["id"] == pid)
    sizes = {s["label"]: s for s in entry["variants"][0]["sizes"]}
    assert sizes["M"]["available"] is False and sizes["S"]["available"] is True and sizes["S"]["low_stock"]
    assert "quantity" not in sizes["S"]  # exact stock is not exposed publicly

    # Owner edit is reflected for customers.
    owner_client.patch(f"/api/owner/products/{pid}", json={"price": "999.00"})
    entry = next(x for x in client.get("/api/catalog").json() if x["id"] == pid)
    assert entry["price"] == "999.00"

    # All sizes sold out -> hidden from catalog.
    vid = p["variants"][0]["id"]
    owner_client.put(f"/api/owner/variants/{vid}/stock", json={"quantities": {"S": 0, "M": 0, "L": 0}})
    assert all(x["id"] != pid for x in client.get("/api/catalog").json())


def test_publish_requires_fields(owner_client):
    pid = make_product(owner_client, price=None)["id"]
    r = owner_client.post(f"/api/owner/products/{pid}/publish")
    assert r.status_code == 422
    problems = " ".join(r.json()["detail"]["problems"])
    assert "price" in problems and "size" in problems and "garment image" in problems


def test_unconfirmed_anchors_block_publish(owner_client):
    p = ready_product(owner_client)
    img = p["variants"][0]["image"]
    owner_client.put(f"/api/owner/images/{img['id']}/anchors", json={"anchors": img["anchors"], "confirmed": False})
    assert owner_client.post(f"/api/owner/products/{p['id']}/publish").status_code == 422


def test_anchor_validation_and_reset(owner_client):
    p = ready_product(owner_client)
    img = p["variants"][0]["image"]
    swapped = {**img["anchors"], "left_shoulder": img["anchors"]["right_shoulder"],
               "right_shoulder": img["anchors"]["left_shoulder"]}
    assert owner_client.put(f"/api/owner/images/{img['id']}/anchors", json={"anchors": swapped}).status_code == 422
    missing = {k: v for k, v in img["anchors"].items() if k != "bottom_center"}
    assert owner_client.put(f"/api/owner/images/{img['id']}/anchors", json={"anchors": missing}).status_code == 422
    moved = {**img["anchors"], "neckline_center": {"x": 0.5, "y": 0.12}}
    r = owner_client.put(f"/api/owner/images/{img['id']}/anchors", json={"anchors": moved})
    assert r.json()["variants"][0]["image"]["anchors"]["neckline_center"] == {"x": 0.5, "y": 0.12}
    r = owner_client.post(f"/api/owner/images/{img['id']}/anchors/reset")
    out = r.json()["variants"][0]["image"]
    assert out["anchors"] == out["anchors_auto"] and out["anchors_confirmed"] is False


def test_adjust_rotate_crop_reset(owner_client):
    p = ready_product(owner_client)
    img = p["variants"][0]["image"]
    r = owner_client.post(f"/api/owner/images/{img['id']}/adjust", json={"rotate_deg": 10})
    assert r.status_code == 200
    rotated = r.json()["variants"][0]["image"]
    assert rotated["processed_url"] != img["processed_url"] and rotated["anchors_confirmed"] is False
    r = owner_client.post(f"/api/owner/images/{img['id']}/adjust", json={"crop": {"x": 0, "y": 0, "w": 1, "h": 0.6}})
    assert r.status_code == 200
    r = owner_client.post(f"/api/owner/images/{img['id']}/adjust", json={"reset": True})
    assert r.status_code == 200 and r.json()["variants"][0]["image"]["meta"]["adjusted"] is False
    # Old processed files are cleaned up, original remains.
    assert owner_client.get(img["processed_url"]).status_code == 404
    assert owner_client.get(img["original_url"]).status_code == 200


def test_reprocess_regenerates_from_original(owner_client):
    p = ready_product(owner_client)
    img = p["variants"][0]["image"]
    r = owner_client.post(f"/api/owner/images/{img['id']}/reprocess")
    new = r.json()["variants"][0]["image"]
    assert new["status"] == "processed" and new["processed_url"] != img["processed_url"]


def test_replace_image_deletes_old_files(owner_client):
    p = ready_product(owner_client)
    vid, old = p["variants"][0]["id"], p["variants"][0]["image"]
    r = owner_client.post(f"/api/owner/variants/{vid}/image",
                          files={"file": ("t.jpg", sample_tee_photo((165, 67, 47)), "image/jpeg")})
    new = r.json()["variants"][0]["image"]
    assert new["status"] == "processed" and new["processed_url"] != old["processed_url"]
    assert new["anchors_confirmed"] is False  # new photo needs a fresh anchor review
    assert owner_client.get(old["processed_url"]).status_code == 404


def test_delete_removes_db_rows_and_files(owner_client, client):
    p = ready_product(owner_client)
    url = p["variants"][0]["image"]["processed_url"]
    assert owner_client.delete(f"/api/owner/products/{p['id']}").status_code == 200
    assert owner_client.get(f"/api/owner/products/{p['id']}").status_code == 404
    assert client.get(url).status_code == 404


def test_archive_hides_from_catalog_and_overview(owner_client, client):
    p = ready_product(owner_client)
    owner_client.post(f"/api/owner/products/{p['id']}/publish")
    assert any(x["id"] == p["id"] for x in client.get("/api/catalog").json())
    owner_client.post(f"/api/owner/products/{p['id']}/archive")
    assert all(x["id"] != p["id"] for x in client.get("/api/catalog").json())


def test_overview_and_inventory_reflect_db(owner_client):
    before = owner_client.get("/api/owner/overview").json()
    ready_product(owner_client, stock={"S": 1, "M": 0, "L": 9})
    after = owner_client.get("/api/owner/overview").json()
    assert after["total_products"] == before["total_products"] + 1
    assert after["drafts"] == before["drafts"] + 1
    assert after["out_of_stock_sizes"] == before["out_of_stock_sizes"] + 1
    rows = owner_client.get("/api/owner/inventory").json()["rows"]
    assert {"out", "low", "ok"} <= {r["state"] for r in rows}


def test_customer_cannot_reach_originals_or_masks(owner_client, client):
    p = ready_product(owner_client)
    img = p["variants"][0]["image"]
    client.cookies.clear()
    assert client.get(img["original_url"]).status_code == 401
    assert client.get("/assets/original/x.jpg").status_code == 404
    assert client.get("/assets/masks/x.png").status_code == 404
    assert client.get("/assets/processed/../../data/test.db").status_code == 404
