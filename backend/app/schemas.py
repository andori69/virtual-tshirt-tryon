from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from .models import SIZE_LABELS


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=256)


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    brand: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=4000)
    price: Decimal | None = Field(default=None, ge=0, le=Decimal("9999999"), decimal_places=2)
    currency: str = Field(default="PHP", pattern=r"^[A-Z]{3}$")


class ProductPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    brand: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    price: Decimal | None = Field(default=None, ge=0, le=Decimal("9999999"), decimal_places=2)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")


class SizeIn(BaseModel):
    label: Literal[SIZE_LABELS]  # type: ignore[valid-type]
    chest_width_cm: float
    shoulder_width_cm: float
    length_cm: float
    sleeve_length_cm: float
    sleeve_opening_cm: float | None = None


class VariantIn(BaseModel):
    color_name: str = Field(min_length=1, max_length=60)
    color_hex: str = Field(default="#888888", pattern=r"^#[0-9a-fA-F]{6}$")


class VariantPatch(BaseModel):
    color_name: str | None = Field(default=None, min_length=1, max_length=60)
    color_hex: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class StockIn(BaseModel):
    quantities: dict[str, int]

    @field_validator("quantities")
    @classmethod
    def _check(cls, v: dict[str, int]):
        for label, qty in v.items():
            if label not in SIZE_LABELS:
                raise ValueError(f"Unknown size {label}.")
            if not (0 <= qty <= 100000):
                raise ValueError("Quantity must be between 0 and 100000.")
        return v


class Point(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class AnchorsIn(BaseModel):
    anchors: dict[str, Point]
    confirmed: bool = True


class CropRect(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0.05, le=1)
    h: float = Field(gt=0.05, le=1)


class AdjustIn(BaseModel):
    rotate_deg: float | None = Field(default=None, ge=-45, le=45)
    crop: CropRect | None = None
    reset: bool = False


class BodySampleIn(BaseModel):
    shoulder_span_px: float = Field(gt=0, lt=10000)
    frame_width: int = Field(gt=0, lt=10000)
    frame_height: int = Field(gt=0, lt=10000)
    chest_width_px: float | None = Field(default=None, gt=0, lt=10000)
    torso_length_px: float | None = Field(default=None, gt=0, lt=10000)
    visibility: float = Field(default=1.0, ge=0, le=1)
    stability_cv: float = Field(default=0.0, ge=0, le=10)
    samples: int = Field(default=1, ge=0, le=100000)


class RecommendIn(BaseModel):
    product_id: int
    variant_id: int | None = None
    body: BodySampleIn


class FitRulesIn(BaseModel):
    ease_tight_max_cm: float = Field(ge=-20, le=40)
    ease_regular_max_cm: float = Field(ge=-20, le=60)
    ease_relaxed_max_cm: float = Field(ge=-20, le=80)
    preferred_fit: Literal["tight", "regular", "relaxed", "oversized"]
    shoulder_landmark_factor: float = Field(ge=0.8, le=1.6)
    body_depth_ratio: float = Field(ge=0.4, le=1.0)
    shoulder_tight_cm: float = Field(ge=-20, le=20)
    shoulder_relaxed_cm: float = Field(ge=-20, le=30)
    shoulder_oversized_cm: float = Field(ge=-20, le=40)
    min_confidence: float = Field(ge=0, le=1)


class MeasurementLimitsIn(BaseModel):
    chest_width_cm: tuple[float, float]
    shoulder_width_cm: tuple[float, float]
    length_cm: tuple[float, float]
    sleeve_length_cm: tuple[float, float]
    sleeve_opening_cm: tuple[float, float]


class StoreSettingsIn(BaseModel):
    default_currency: str = Field(pattern=r"^[A-Z]{3}$")
    low_stock_threshold: int = Field(ge=0, le=10000)
    kiosk_idle_reset_s: int = Field(ge=10, le=3600)


class CameraSettingsIn(BaseModel):
    width: int = Field(ge=320, le=3840)
    height: int = Field(ge=240, le=2160)
    frame_rate: int = Field(ge=5, le=60)


SETTINGS_SCHEMAS = {
    "fit_rules": FitRulesIn,
    "measurement_limits": MeasurementLimitsIn,
    "store": StoreSettingsIn,
    "camera": CameraSettingsIn,
}
