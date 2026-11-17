from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ..database import get_db
from ..schemas import SETTINGS_SCHEMAS
from ..security import current_owner
from ..settings_store import DEFAULTS, get_setting, put_setting

router = APIRouter(prefix="/api/owner/settings", tags=["settings"], dependencies=[Depends(current_owner)])


@router.get("")
def all_settings(db: Session = Depends(get_db)):
    return {key: get_setting(db, key) for key in DEFAULTS} | {"defaults": DEFAULTS}


@router.put("/{key}")
def update_setting(key: str, value: dict = Body(...), db: Session = Depends(get_db)):
    schema = SETTINGS_SCHEMAS.get(key)
    if schema is None:
        raise HTTPException(404, "Unknown setting.")
    try:
        parsed = schema(**value).model_dump()
    except ValidationError as e:
        raise HTTPException(422, {"message": "Invalid settings.", "problems": [err["msg"] for err in e.errors()]})
    if key == "fit_rules":
        if not parsed["ease_tight_max_cm"] < parsed["ease_regular_max_cm"] < parsed["ease_relaxed_max_cm"]:
            raise HTTPException(422, "Ease thresholds must increase: tight < regular < relaxed.")
        if not parsed["shoulder_tight_cm"] < parsed["shoulder_relaxed_cm"] < parsed["shoulder_oversized_cm"]:
            raise HTTPException(422, "Shoulder thresholds must increase.")
    if key == "measurement_limits" and any(lo <= 0 or lo >= hi for lo, hi in parsed.values()):
        raise HTTPException(422, "Each limit needs a positive minimum below its maximum.")
    return put_setting(db, key, parsed)
