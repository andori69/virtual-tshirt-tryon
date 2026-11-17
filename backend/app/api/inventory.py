from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import SIZE_LABELS, Inventory, Product, Variant
from ..security import current_owner
from ..services.products import product_summary
from ..settings_store import get_setting

router = APIRouter(prefix="/api/owner", tags=["owner-inventory"], dependencies=[Depends(current_owner)])


def _rows(db: Session) -> list[Inventory]:
    return list(db.scalars(
        select(Inventory)
        .join(Variant).join(Product)
        .where(Product.status != "archived")
        .options(selectinload(Inventory.variant).selectinload(Variant.product), selectinload(Inventory.size))
    ))


@router.get("/inventory")
def inventory(db: Session = Depends(get_db)):
    low = get_setting(db, "store")["low_stock_threshold"]
    rows = [{
        "product_id": inv.variant.product_id,
        "product_name": inv.variant.product.name,
        "status": inv.variant.product.status,
        "variant_id": inv.variant_id,
        "color_name": inv.variant.color_name,
        "size": inv.size.label,
        "quantity": inv.quantity,
        "state": "out" if inv.quantity == 0 else "low" if inv.quantity <= low else "ok",
    } for inv in _rows(db)]
    rows.sort(key=lambda r: (r["product_name"].lower(), r["color_name"], SIZE_LABELS.index(r["size"])))
    return {"low_stock_threshold": low, "rows": rows}


@router.get("/overview")
def overview(db: Session = Depends(get_db)):
    products = list(db.scalars(select(Product).order_by(Product.created_at.desc())))
    low = get_setting(db, "store")["low_stock_threshold"]
    rows = _rows(db)
    low_products = {inv.variant.product_id for inv in rows if 0 < inv.quantity <= low}
    return {
        "total_products": sum(p.status != "archived" for p in products),
        "published": sum(p.status == "published" for p in products),
        "drafts": sum(p.status == "draft" for p in products),
        "archived": sum(p.status == "archived" for p in products),
        "low_stock_products": len(low_products),
        "out_of_stock_sizes": sum(inv.quantity == 0 for inv in rows),
        "low_stock_threshold": low,
        "recent": [product_summary(p) for p in products if p.status != "archived"][:5],
    }
