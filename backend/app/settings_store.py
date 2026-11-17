"""Store-tunable settings persisted in the `settings` table, with documented defaults."""
import copy

from sqlalchemy.orm import Session

from .models import Setting

DEFAULTS: dict[str, dict] = {
    # Fit is judged on ease = garment chest circumference (2 x flat chest width) - estimated body chest circumference.
    "fit_rules": {
        "ease_tight_max_cm": 4.0,       # ease below this -> Tight
        "ease_regular_max_cm": 12.0,    # up to this -> Regular
        "ease_relaxed_max_cm": 20.0,    # up to this -> Relaxed, above -> Oversized
        "preferred_fit": "regular",
        "shoulder_landmark_factor": 1.15,  # pose shoulder joints sit inside the seam line; seam width ~ span x factor
        "body_depth_ratio": 0.72,        # chest depth / visible chest width, for the ellipse circumference estimate
        "shoulder_tight_cm": -2.0,       # garment shoulder minus body shoulder, used when chest width is unavailable
        "shoulder_relaxed_cm": 3.0,
        "shoulder_oversized_cm": 6.0,
        "min_confidence": 0.35,          # below this the kiosk says it cannot recommend a size
    },
    "measurement_limits": {
        "chest_width_cm": [25, 90],
        "shoulder_width_cm": [25, 75],
        "length_cm": [40, 110],
        "sleeve_length_cm": [5, 80],
        "sleeve_opening_cm": [8, 40],
    },
    "store": {"default_currency": "PHP", "low_stock_threshold": 3, "kiosk_idle_reset_s": 60},
    "camera": {"width": 1280, "height": 720, "frame_rate": 30},
}


def get_setting(db: Session, key: str) -> dict:
    row = db.get(Setting, key)
    value = copy.deepcopy(DEFAULTS[key])
    if row:
        value.update(row.value)
    return value


def put_setting(db: Session, key: str, value: dict) -> dict:
    merged = {**DEFAULTS[key], **{k: v for k, v in value.items() if k in DEFAULTS[key]}}
    row = db.get(Setting, key)
    if row:
        row.value = merged
    else:
        db.add(Setting(key=key, value=merged))
    db.commit()
    return merged
