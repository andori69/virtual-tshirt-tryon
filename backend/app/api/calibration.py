from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .. import config
from ..calibration import aruco
from ..database import get_db
from ..models import Calibration
from ..security import current_owner

router = APIRouter(prefix="/api/owner/calibration", tags=["calibration"], dependencies=[Depends(current_owner)])


def active_calibration(db: Session) -> Calibration | None:
    return db.scalar(select(Calibration).where(Calibration.is_active).order_by(Calibration.id.desc()))


def calibration_dict(c: Calibration | None) -> dict | None:
    if c is None:
        return None
    return {
        "id": c.id,
        "marker_dictionary": c.marker_dictionary,
        "marker_id": c.marker_id,
        "marker_size_cm": c.marker_size_cm,
        "marker_side_px": c.marker_side_px,
        "px_per_cm": c.px_per_cm,
        "frame_width": c.frame_width,
        "frame_height": c.frame_height,
        "skew_ratio": c.skew_ratio,
        "camera_label": c.camera_label,
        "created_at": c.created_at.isoformat(),
    }


def _read_frame(file: UploadFile) -> bytes:
    data = file.file.read(int(config.MAX_UPLOAD_MB * 1024 * 1024) + 1)
    if len(data) > config.MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, "Calibration frame is too large.")
    return data


def _detect(data: bytes, marker_size_cm: float, marker_id: int | None) -> dict:
    try:
        return aruco.detect(data, marker_size_cm, marker_id)
    except aruco.CalibrationError as e:
        raise HTTPException(422, str(e))


@router.get("")
def get_calibration(db: Session = Depends(get_db)):
    return {"active": calibration_dict(active_calibration(db))}


@router.get("/marker.png")
def marker(marker_id: int = 0):
    if not (0 <= marker_id < 50):
        raise HTTPException(422, "Marker id must be 0-49.")
    return Response(aruco.marker_png(marker_id), media_type="image/png")


@router.post("/detect")
def detect(file: UploadFile = File(...), marker_size_cm: float = Form(...), marker_id: int | None = Form(None)):
    return _detect(_read_frame(file), marker_size_cm, marker_id)


@router.post("")
def save(
    file: UploadFile = File(...),
    marker_size_cm: float = Form(...),
    marker_id: int | None = Form(None),
    camera_label: str = Form(""),
    db: Session = Depends(get_db),
):
    # Recompute from the frame on the server instead of trusting client numbers.
    r = _detect(_read_frame(file), marker_size_cm, marker_id)
    db.execute(update(Calibration).values(is_active=False))
    c = Calibration(
        marker_dictionary=r["marker_dictionary"], marker_id=r["marker_id"], marker_size_cm=marker_size_cm,
        marker_side_px=r["marker_side_px"], px_per_cm=r["px_per_cm"], frame_width=r["frame_width"],
        frame_height=r["frame_height"], skew_ratio=r["skew_ratio"], camera_label=camera_label[:120], is_active=True,
    )
    db.add(c)
    db.commit()
    return {"active": calibration_dict(c), "detection": r}


@router.delete("")
def clear(db: Session = Depends(get_db)):
    db.execute(update(Calibration).values(is_active=False))
    db.commit()
    return {"active": None}
