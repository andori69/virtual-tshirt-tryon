"""Public kiosk endpoints. Read-only except /recommend, which is stateless: body estimates are never stored."""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import wardrobe
from ..database import get_db
from ..fitting.recommend import BodySample, CalibrationInfo, SizeSpec, recommend
from ..models import Product
from ..schemas import RecommendIn
from ..services.products import catalog_entry, load_product, sorted_sizes, stock_by_label, variant_ready
from ..settings_store import get_setting
from .calibration import active_calibration

router = APIRouter(prefix="/api", tags=["kiosk"])


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/wardrobe")
def wardrobe_list():
    # Scans the shirt folder on every call, so a newly dropped file shows up on the next page load.
    return wardrobe.scan()


@router.get("/wardrobe/{key}/mesh.json")
def wardrobe_mesh(key: str):
    path = wardrobe.asset_path(key, "mesh")
    if path is None:
        raise HTTPException(404, "Not found.")
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": "public, max-age=86400, immutable"})


@router.get("/wardrobe/{key}/{kind}.png")
def wardrobe_asset(key: str, kind: str):
    path = wardrobe.asset_path(key, kind) if kind != "mesh" else None
    if path is None:
        raise HTTPException(404, "Not found.")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400, immutable"})


@router.get("/catalog")
def catalog(db: Session = Depends(get_db)):
    low = get_setting(db, "store")["low_stock_threshold"]
    ids = db.scalars(select(Product.id).where(Product.status == "published").order_by(Product.updated_at.desc()))
    return [e for pid in list(ids) if (e := catalog_entry(load_product(db, pid), low))]


@router.get("/kiosk/config")
def kiosk_config(db: Session = Depends(get_db)):
    cal = active_calibration(db)
    return {
        "camera": get_setting(db, "camera"),
        "idle_reset_s": get_setting(db, "store")["kiosk_idle_reset_s"],
        "shoulder_landmark_factor": get_setting(db, "fit_rules")["shoulder_landmark_factor"],
        "calibration": {"px_per_cm": cal.px_per_cm, "frame_width": cal.frame_width, "frame_height": cal.frame_height}
        if cal else None,
    }


@router.post("/fitting/recommend")
def recommend_size(body: RecommendIn, db: Session = Depends(get_db)):
    p = load_product(db, body.product_id)
    if p is None or p.status != "published":
        raise HTTPException(404, "Product not found.")
    variant = next((v for v in p.variants if v.id == body.variant_id and variant_ready(v)), None)
    stock = stock_by_label(variant) if variant else {}
    sizes = [
        SizeSpec(s.label, s.chest_width_cm, s.shoulder_width_cm, s.length_cm, in_stock=stock.get(s.label, 0) > 0)
        for s in sorted_sizes(p)
    ]
    cal = active_calibration(db)
    cal_info = CalibrationInfo(cal.px_per_cm, cal.frame_width, cal.frame_height) if cal else None
    return recommend(BodySample(**body.body.model_dump()), sizes, cal_info, get_setting(db, "fit_rules"))
