"""Asset files live under config.ASSETS_DIR/<subdir>/<random>.<ext>. The DB stores the relative path only."""
import io
import logging
import uuid
from pathlib import Path

from PIL import Image

from .. import config

log = logging.getLogger(__name__)


def abs_path(rel: str) -> Path:
    path = (config.ASSETS_DIR / rel).resolve()
    if config.ASSETS_DIR not in path.parents:
        raise ValueError("Asset path escapes the asset directory.")
    return path


def save_bytes(subdir: str, ext: str, data: bytes) -> str:
    assert subdir in config.ASSET_SUBDIRS
    rel = f"{subdir}/{uuid.uuid4().hex}.{ext}"
    abs_path(rel).write_bytes(data)
    return rel


def save_png(subdir: str, img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return save_bytes(subdir, "png", buf.getvalue())


def delete_files(paths: list[str | None]) -> None:
    for rel in paths:
        if not rel:
            continue
        try:
            abs_path(rel).unlink(missing_ok=True)
        except (OSError, ValueError):
            log.warning("could not delete asset %s", rel)
