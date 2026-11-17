"""Owner product management: products, sizes, colors, garment images, anchors. All routes need a session."""
import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import config
from ..database import get_db
from ..image_processing import pipeline
from ..image_processing.anchors import AnchorEstimationError, validate_anchors
from ..image_processing.validation import ImageValidationError, validate_image_bytes
from ..models import GarmentImage, Inventory, Product, ProductSize, Variant, utcnow
from ..schemas import AdjustIn, AnchorsIn, ProductIn, ProductPatch, SizeIn, StockIn, VariantIn, VariantPatch
from ..security import current_owner
from ..services import storage
from ..services.products import MEASUREMENT_FIELDS, load_product, product_detail, product_summary, publish_problems
from ..settings_store import get_setting

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/owner", tags=["owner-products"], dependencies=[Depends(current_owner)])


def _product(db: Session, product_id: int) -> Product:
    p = load_product(db, product_id)
    if p is None:
        raise HTTPException(404, "Product not found.")
    return p


def _variant(db: Session, variant_id: int) -> Variant:
    v = db.get(Variant, variant_id)
    if v is None:
        raise HTTPException(404, "Color not found.")
    return v


def _image(db: Session, image_id: int) -> GarmentImage:
    img = db.get(GarmentImage, image_id)
    if img is None:
        raise HTTPException(404, "Image not found.")
    return img


def _detail(db: Session, product_id: int) -> dict:
    db.expire_all()
    return product_detail(_product(db, product_id))


@router.get("/products")
def list_products(status: str | None = None, db: Session = Depends(get_db)):
    q = select(Product).order_by(Product.updated_at.desc())
    if status:
        q = q.where(Product.status == status)
    return [product_summary(p) for p in db.scalars(q)]


@router.post("/products", status_code=201)
def create_product(body: ProductIn, db: Session = Depends(get_db)):
    p = Product(**body.model_dump(), status="draft")
    db.add(p)
    db.commit()
    return _detail(db, p.id)


@router.get("/products/{product_id}")
def get_product(product_id: int, db: Session = Depends(get_db)):
    return product_detail(_product(db, product_id))


@router.patch("/products/{product_id}")
def update_product(product_id: int, body: ProductPatch, db: Session = Depends(get_db)):
    p = _product(db, product_id)
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is None and k != "price":
            continue
        setattr(p, k, v)
    db.commit()
    return _detail(db, p.id)


@router.delete("/products/{product_id}")
def delete_product(product_id: int, db: Session = Depends(get_db)):
    p = _product(db, product_id)
    files = [path for v in p.variants for img in v.images for path in img.asset_paths()]
    db.delete(p)
    db.commit()  # DB first: a failed file delete leaves an orphan file, never a dangling DB reference
    storage.delete_files(files)
    return {"ok": True}


@router.post("/products/{product_id}/publish")
def publish(product_id: int, db: Session = Depends(get_db)):
    p = _product(db, product_id)
    problems = publish_problems(p)
    if problems:
        raise HTTPException(422, {"message": "The product is not ready to publish.", "problems": problems})
    p.status = "published"
    db.commit()
    return _detail(db, p.id)


@router.post("/products/{product_id}/unpublish")
def unpublish(product_id: int, db: Session = Depends(get_db)):
    p = _product(db, product_id)
    p.status = "draft"
    db.commit()
    return _detail(db, p.id)


@router.post("/products/{product_id}/archive")
def archive(product_id: int, db: Session = Depends(get_db)):
    p = _product(db, product_id)
    p.status = "archived"
    db.commit()
    return _detail(db, p.id)


@router.put("/products/{product_id}/sizes")
def put_sizes(product_id: int, sizes: list[SizeIn], db: Session = Depends(get_db)):
    p = _product(db, product_id)
    labels = [s.label for s in sizes]
    if len(set(labels)) != len(labels):
        raise HTTPException(422, "Each size can only appear once.")
    limits = get_setting(db, "measurement_limits")
    errors = []
    for s in sizes:
        for f in MEASUREMENT_FIELDS:
            val = getattr(s, f)
            if val is None and f == "sleeve_opening_cm":
                continue
            lo, hi = limits[f]
            if val is None or not (lo <= val <= hi):
                errors.append(f"{s.label}: {f.removesuffix('_cm').replace('_', ' ')} must be {lo}-{hi} cm.")
    if errors:
        raise HTTPException(422, {"message": "Some measurements are invalid.", "problems": errors})

    existing = {s.label: s for s in p.sizes}
    for label, row in existing.items():
        if label not in labels:
            db.delete(row)
    for s in sizes:
        row = existing.get(s.label)
        if row is None:
            row = ProductSize(product=p, label=s.label, **{f: getattr(s, f) for f in MEASUREMENT_FIELDS})
            db.add(row)
            for v in p.variants:
                db.add(Inventory(variant=v, size=row, quantity=0))
        else:
            for f in MEASUREMENT_FIELDS:
                setattr(row, f, getattr(s, f))
    p.updated_at = utcnow()
    db.commit()
    return _detail(db, p.id)


@router.post("/products/{product_id}/variants", status_code=201)
def add_variant(product_id: int, body: VariantIn, db: Session = Depends(get_db)):
    p = _product(db, product_id)
    v = Variant(product=p, sort_order=len(p.variants), **body.model_dump())
    db.add(v)
    for s in p.sizes:
        db.add(Inventory(variant=v, size=s, quantity=0))
    db.commit()
    return _detail(db, p.id)


@router.patch("/variants/{variant_id}")
def update_variant(variant_id: int, body: VariantPatch, db: Session = Depends(get_db)):
    v = _variant(db, variant_id)
    for k, val in body.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(v, k, val)
    db.commit()
    return _detail(db, v.product_id)


@router.delete("/variants/{variant_id}")
def delete_variant(variant_id: int, db: Session = Depends(get_db)):
    v = _variant(db, variant_id)
    pid = v.product_id
    files = [path for img in v.images for path in img.asset_paths()]
    db.delete(v)
    db.commit()
    storage.delete_files(files)
    return _detail(db, pid)


@router.put("/variants/{variant_id}/stock")
def put_stock(variant_id: int, body: StockIn, db: Session = Depends(get_db)):
    v = _variant(db, variant_id)
    rows = {inv.size.label: inv for inv in v.stock}
    unknown = set(body.quantities) - set(rows)
    if unknown:
        raise HTTPException(422, f"Size(s) {', '.join(sorted(unknown))} are not defined for this product.")
    for label, qty in body.quantities.items():
        rows[label].quantity = qty
    db.commit()
    return _detail(db, v.product_id)


# ---- garment images -------------------------------------------------------------------------

def _apply_assets(img: GarmentImage, assets: pipeline.GarmentAssets, keep_cutout: bool) -> list[str]:
    """Saves new asset files onto `img`; returns the paths they replaced (to delete after commit)."""
    old = [img.processed_path, img.mask_path, img.thumb_path]
    if not keep_cutout:
        old.append(img.cutout_path)
        img.cutout_path = storage.save_png("cutouts", assets.cutout)
    img.processed_path = storage.save_png("processed", assets.processed)
    img.mask_path = storage.save_png("masks", assets.mask)
    img.thumb_path = storage.save_png("thumbs", assets.thumb)
    img.anchors_auto = assets.anchors
    img.anchors = assets.anchors
    img.anchors_confirmed = False
    img.status, img.error = "processed", None
    img.processing_meta = {**(img.processing_meta or {}), **assets.meta} if keep_cutout else assets.meta
    return old


def _run_processing(db: Session, img: GarmentImage) -> None:
    try:
        assets = pipeline.process_original(storage.abs_path(img.original_path))
    except pipeline.GarmentProcessingError as e:
        img.status, img.error = "failed", str(e)
        db.commit()
        return
    old = _apply_assets(img, assets, keep_cutout=False)
    db.commit()
    storage.delete_files(old)


@router.post("/variants/{variant_id}/image")
def upload_image(variant_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    v = _variant(db, variant_id)
    data = file.file.read(int(config.MAX_UPLOAD_MB * 1024 * 1024) + 1)
    try:
        ext, _, _ = validate_image_bytes(data)
    except ImageValidationError as e:
        raise HTTPException(e.status, str(e))

    previous = v.front_image
    old_files = previous.asset_paths() if previous else []
    if previous:
        db.delete(previous)
        db.flush()
    img = GarmentImage(variant=v, view="front", original_path=storage.save_bytes("original", ext, data))
    db.add(img)
    db.commit()
    storage.delete_files(old_files)
    _run_processing(db, img)
    return _detail(db, v.product_id)


@router.post("/images/{image_id}/reprocess")
def reprocess(image_id: int, db: Session = Depends(get_db)):
    img = _image(db, image_id)
    _run_processing(db, img)
    return _detail(db, img.variant.product_id)


@router.post("/images/{image_id}/adjust")
def adjust(image_id: int, body: AdjustIn, db: Session = Depends(get_db)):
    img = _image(db, image_id)
    if img.status != "processed":
        raise HTTPException(409, "Process the image before adjusting it.")
    try:
        if body.reset:
            with Image.open(storage.abs_path(img.cutout_path)) as c:
                assets = pipeline.normalize(c.convert("RGBA"))
        else:
            with Image.open(storage.abs_path(img.processed_path)) as src:
                src = src.convert("RGBA")
                if body.rotate_deg:
                    assets = pipeline.rotate(src, body.rotate_deg)
                elif body.crop:
                    assets = pipeline.crop(src, body.crop.model_dump())
                else:
                    raise HTTPException(422, "Nothing to adjust.")
    except FileNotFoundError:
        raise HTTPException(409, "Processed files are missing. Reprocess the original image.")
    except pipeline.GarmentProcessingError as e:
        raise HTTPException(422, str(e))
    old = _apply_assets(img, assets, keep_cutout=True)
    img.processing_meta["adjusted"] = not body.reset
    db.commit()
    storage.delete_files(old)
    return _detail(db, img.variant.product_id)


@router.put("/images/{image_id}/anchors")
def put_anchors(image_id: int, body: AnchorsIn, db: Session = Depends(get_db)):
    img = _image(db, image_id)
    if img.status != "processed":
        raise HTTPException(409, "Process the image before editing anchor points.")
    try:
        img.anchors = validate_anchors({k: p.model_dump() for k, p in body.anchors.items()})
    except AnchorEstimationError as e:
        raise HTTPException(422, str(e))
    img.anchors_confirmed = body.confirmed
    db.commit()
    return _detail(db, img.variant.product_id)


@router.post("/images/{image_id}/anchors/reset")
def reset_anchors(image_id: int, db: Session = Depends(get_db)):
    img = _image(db, image_id)
    img.anchors = img.anchors_auto
    img.anchors_confirmed = False
    db.commit()
    return _detail(db, img.variant.product_id)


@router.get("/images/{image_id}/original")
def original_file(image_id: int, db: Session = Depends(get_db)):
    img = _image(db, image_id)
    path = storage.abs_path(img.original_path)
    if not path.is_file():
        raise HTTPException(404, "Original file is missing.")
    return FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})
