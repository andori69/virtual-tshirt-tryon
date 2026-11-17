from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base

SIZE_LABELS = ("XS", "S", "M", "L", "XL", "XXL")
PRODUCT_STATUSES = ("draft", "published", "archived")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Owner(Base):
    __tablename__ = "owners"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OwnerSession(Base):
    __tablename__ = "owner_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("owners.id", ondelete="CASCADE"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    owner: Mapped[Owner] = relationship()


class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    brand: Mapped[str] = mapped_column(String(120), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    price: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="PHP")
    status: Mapped[str] = mapped_column(String(16), default="draft")
    is_sample: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    variants: Mapped[list["Variant"]] = relationship(
        back_populates="product", cascade="all, delete-orphan", order_by="Variant.sort_order, Variant.id"
    )
    sizes: Mapped[list["ProductSize"]] = relationship(back_populates="product", cascade="all, delete-orphan")


class Variant(Base):
    """A color of a product. Each color has its own garment image and its own stock per size."""

    __tablename__ = "variants"
    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    color_name: Mapped[str] = mapped_column(String(60))
    color_hex: Mapped[str] = mapped_column(String(7), default="#888888")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    product: Mapped[Product] = relationship(back_populates="variants")
    images: Mapped[list["GarmentImage"]] = relationship(back_populates="variant", cascade="all, delete-orphan")
    stock: Mapped[list["Inventory"]] = relationship(back_populates="variant", cascade="all, delete-orphan")

    @property
    def front_image(self) -> "GarmentImage | None":
        return next((i for i in self.images if i.view == "front"), None)


class ProductSize(Base):
    """Actual flat garment measurements (cm) for one size; shared by all colors of the product."""

    __tablename__ = "product_sizes"
    __table_args__ = (UniqueConstraint("product_id", "label"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    label: Mapped[str] = mapped_column(String(4))
    chest_width_cm: Mapped[float] = mapped_column(Float)
    shoulder_width_cm: Mapped[float] = mapped_column(Float)
    length_cm: Mapped[float] = mapped_column(Float)
    sleeve_length_cm: Mapped[float] = mapped_column(Float)
    sleeve_opening_cm: Mapped[float | None] = mapped_column(Float, nullable=True)

    product: Mapped[Product] = relationship(back_populates="sizes")
    stock: Mapped[list["Inventory"]] = relationship(back_populates="size", cascade="all, delete-orphan")


class Inventory(Base):
    __tablename__ = "inventory"
    __table_args__ = (UniqueConstraint("variant_id", "size_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    variant_id: Mapped[int] = mapped_column(ForeignKey("variants.id", ondelete="CASCADE"))
    size_id: Mapped[int] = mapped_column(ForeignKey("product_sizes.id", ondelete="CASCADE"))
    quantity: Mapped[int] = mapped_column(Integer, default=0)

    variant: Mapped[Variant] = relationship(back_populates="stock")
    size: Mapped[ProductSize] = relationship(back_populates="stock")


class GarmentImage(Base):
    """Original photo plus its processed assets. `view` keeps room for back/side views later."""

    __tablename__ = "garment_images"
    __table_args__ = (UniqueConstraint("variant_id", "view"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    variant_id: Mapped[int] = mapped_column(ForeignKey("variants.id", ondelete="CASCADE"))
    view: Mapped[str] = mapped_column(String(16), default="front")
    original_path: Mapped[str] = mapped_column(String(255))
    cutout_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    processed_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mask_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    thumb_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="uploaded")  # uploaded|processed|failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    anchors: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    anchors_auto: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    anchors_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    processing_meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    variant: Mapped[Variant] = relationship(back_populates="images")

    def asset_paths(self) -> list[str]:
        return [p for p in (self.original_path, self.cutout_path, self.processed_path, self.mask_path, self.thumb_path) if p]


class Calibration(Base):
    __tablename__ = "calibrations"
    id: Mapped[int] = mapped_column(primary_key=True)
    marker_dictionary: Mapped[str] = mapped_column(String(32))
    marker_id: Mapped[int] = mapped_column(Integer)
    marker_size_cm: Mapped[float] = mapped_column(Float)
    marker_side_px: Mapped[float] = mapped_column(Float)
    px_per_cm: Mapped[float] = mapped_column(Float)
    frame_width: Mapped[int] = mapped_column(Integer)
    frame_height: Mapped[int] = mapped_column(Integer)
    skew_ratio: Mapped[float] = mapped_column(Float)
    camera_label: Mapped[str] = mapped_column(String(120), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)
