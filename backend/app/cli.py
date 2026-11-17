"""Admin CLI.

  python -m app.cli create-owner <username>      # prompts for a password
  python -m app.cli seed-samples                 # adds clearly-labelled SAMPLE products (runs the real pipeline)
"""
import argparse
import getpass
import sys
from decimal import Decimal

from sqlalchemy import select

from .database import SessionLocal, init_db
from .image_processing import pipeline
from .models import GarmentImage, Inventory, Owner, Product, ProductSize, Variant
from .sample_data import SAMPLE_PRODUCTS, sample_tee_photo
from .security import hash_password
from .services import storage


def create_owner(username: str, password: str | None) -> None:
    init_db()
    if password is None:
        password = getpass.getpass("Password (min 10 chars): ")
        if password != getpass.getpass("Repeat password: "):
            sys.exit("Passwords do not match.")
    if len(password) < 10:
        sys.exit("Password must be at least 10 characters.")
    with SessionLocal() as db:
        owner = db.scalar(select(Owner).where(Owner.username == username))
        if owner:
            owner.password_hash = hash_password(password)
            print(f"Updated password for owner '{username}'.")
        else:
            db.add(Owner(username=username, password_hash=hash_password(password)))
            print(f"Created owner '{username}'.")
        db.commit()


def seed_samples() -> None:
    init_db()
    with SessionLocal() as db:
        if db.scalar(select(Product).where(Product.is_sample)):
            print("Sample products already exist; nothing to do.")
            return
        for i, spec in enumerate(SAMPLE_PRODUCTS):
            p = Product(name=spec["name"], brand=spec["brand"], description=spec["description"],
                        price=Decimal(spec["price"]), currency="PHP", status="draft", is_sample=True)
            db.add(p)
            sizes = {
                label: ProductSize(product=p, label=label, chest_width_cm=c, shoulder_width_cm=sh,
                                   length_cm=ln, sleeve_length_cm=sl)
                for label, (c, sh, ln, sl) in spec["sizes"].items()
            }
            db.add_all(sizes.values())
            for j, (cname, chex, rgb) in enumerate(spec["colors"]):
                v = Variant(product=p, color_name=cname, color_hex=chex, sort_order=j)
                db.add(v)
                for label, row in sizes.items():
                    db.add(Inventory(variant=v, size=row, quantity=spec["stock"].get(label, 0)))
                original = storage.save_bytes("original", "jpg", sample_tee_photo(rgb, seed=i * 10 + j))
                assets = pipeline.process_original(storage.abs_path(original))
                db.add(GarmentImage(
                    variant=v, view="front", original_path=original,
                    cutout_path=storage.save_png("cutouts", assets.cutout),
                    processed_path=storage.save_png("processed", assets.processed),
                    mask_path=storage.save_png("masks", assets.mask),
                    thumb_path=storage.save_png("thumbs", assets.thumb),
                    status="processed", anchors=assets.anchors, anchors_auto=assets.anchors,
                    anchors_confirmed=assets.anchors is not None, processing_meta=assets.meta,
                ))
                print(f"  {spec['name']} / {cname}: processed in {assets.meta['processing_ms']} ms")
            p.status = "published"
        db.commit()
    print("Seeded sample products (marked SAMPLE).")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m app.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-owner")
    c.add_argument("username")
    c.add_argument("--password-stdin", action="store_true", help="read the password from stdin (for scripts)")
    sub.add_parser("seed-samples")
    args = ap.parse_args(argv)
    if args.cmd == "create-owner":
        create_owner(args.username, sys.stdin.readline().rstrip("\n") if args.password_stdin else None)
    else:
        seed_samples()


if __name__ == "__main__":
    main()
