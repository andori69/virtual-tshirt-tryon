"""Product rules shared by owner and customer APIs: publish readiness and serialization."""
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..models import SIZE_LABELS, GarmentImage, Inventory, Product, ProductSize, Variant

MEASUREMENT_FIELDS = ("chest_width_cm", "shoulder_width_cm", "length_cm", "sleeve_length_cm", "sleeve_opening_cm")


def asset_url(rel: str | None) -> str | None:
    return f"/assets/{rel}" if rel else None


def load_product(db: Session, product_id: int) -> Product | None:
    return db.scalar(
        select(Product)
        .where(Product.id == product_id)
        .options(
            selectinload(Product.sizes),
            selectinload(Product.variants).selectinload(Variant.images),
            selectinload(Product.variants).selectinload(Variant.stock).selectinload(Inventory.size),
        )
    )


def sorted_sizes(product: Product) -> list[ProductSize]:
    return sorted(product.sizes, key=lambda s: SIZE_LABELS.index(s.label))


def variant_ready(v: Variant) -> bool:
    img = v.front_image
    return bool(img and img.status == "processed" and img.processed_path and img.anchors and img.anchors_confirmed)


def stock_by_label(v: Variant) -> dict[str, int]:
    return {inv.size.label: inv.quantity for inv in v.stock}


def publish_problems(p: Product) -> list[str]:
    problems = []
    if not p.name.strip():
        problems.append("Product name is required.")
    if p.price is None or p.price <= 0:
        problems.append("A price greater than zero is required.")
    if not p.sizes:
        problems.append("Add at least one size with measurements.")
    ready = [v for v in p.variants if variant_ready(v)]
    if not ready:
        problems.append("At least one color needs a processed garment image with confirmed anchor points.")
    elif not any(q > 0 for v in ready for q in stock_by_label(v).values()):
        problems.append("At least one size of a ready color must be in stock.")
    return problems


def image_dict(img: GarmentImage | None) -> dict | None:
    if img is None:
        return None
    return {
        "id": img.id,
        "view": img.view,
        "status": img.status,
        "error": img.error,
        "original_url": f"/api/owner/images/{img.id}/original",
        "processed_url": asset_url(img.processed_path),
        "thumb_url": asset_url(img.thumb_path),
        "anchors": img.anchors,
        "anchors_auto": img.anchors_auto,
        "anchors_confirmed": img.anchors_confirmed,
        "meta": img.processing_meta,
        "updated_at": img.updated_at.isoformat(),
    }


def size_dict(s: ProductSize) -> dict:
    return {"id": s.id, "label": s.label, **{f: getattr(s, f) for f in MEASUREMENT_FIELDS}}


def product_summary(p: Product) -> dict:
    thumb = next((v.front_image.thumb_path for v in p.variants if v.front_image and v.front_image.thumb_path), None)
    return {
        "id": p.id,
        "name": p.name,
        "brand": p.brand,
        "price": str(p.price) if p.price is not None else None,
        "currency": p.currency,
        "status": p.status,
        "is_sample": p.is_sample,
        "thumb_url": asset_url(thumb),
        "colors": [v.color_name for v in p.variants],
        "sizes": [s.label for s in sorted_sizes(p)],
        "total_stock": sum(inv.quantity for v in p.variants for inv in v.stock),
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
    }


def product_detail(p: Product) -> dict:
    problems = publish_problems(p)
    return {
        **product_summary(p),
        "description": p.description,
        "sizes": [size_dict(s) for s in sorted_sizes(p)],
        "variants": [
            {
                "id": v.id,
                "color_name": v.color_name,
                "color_hex": v.color_hex,
                "ready": variant_ready(v),
                "image": image_dict(v.front_image),
                "stock": stock_by_label(v),
            }
            for v in p.variants
        ],
        "publish_ready": not problems,
        "publish_problems": problems,
    }


def catalog_entry(p: Product, low_stock: int) -> dict | None:
    """Customer view: only ready colors, availability flags instead of exact quantities."""
    if p.status != "published" or publish_problems(p):
        return None
    sizes = sorted_sizes(p)
    variants = []
    for v in p.variants:
        if not variant_ready(v):
            continue
        stock = stock_by_label(v)
        avail = [{"label": s.label, "available": stock.get(s.label, 0) > 0,
                  "low_stock": 0 < stock.get(s.label, 0) <= low_stock} for s in sizes]
        if not any(a["available"] for a in avail):
            continue
        img = v.front_image
        variants.append({
            "id": v.id,
            "color_name": v.color_name,
            "color_hex": v.color_hex,
            "garment_url": asset_url(img.processed_path),
            "thumb_url": asset_url(img.thumb_path),
            "anchors": img.anchors,
            "sizes": avail,
        })
    if not variants:
        return None
    return {
        "id": p.id,
        "name": p.name,
        "brand": p.brand,
        "description": p.description,
        "price": str(p.price),
        "currency": p.currency,
        "is_sample": p.is_sample,
        "size_chart": [size_dict(s) for s in sizes],
        "variants": variants,
    }
