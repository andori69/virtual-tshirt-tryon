"""Runtime configuration from environment variables (optionally loaded from backend/.env)."""
import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    # Minimal KEY=VALUE loader so no extra dependency is needed; real env vars win.
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(BACKEND_DIR / ".env")

ASSETS_DIR = Path(os.environ.get("VFR_ASSETS_DIR", BACKEND_DIR / "assets")).resolve()
DATABASE_URL = os.environ.get("VFR_DATABASE_URL", f"sqlite:///{BACKEND_DIR / 'data' / 'fitting_room.db'}")
REMBG_MODEL = os.environ.get("VFR_REMBG_MODEL", "u2net")
MAX_UPLOAD_MB = float(os.environ.get("VFR_MAX_UPLOAD_MB", "15"))
MIN_IMAGE_SIDE = int(os.environ.get("VFR_MIN_IMAGE_SIDE", "256"))
MAX_IMAGE_SIDE = int(os.environ.get("VFR_MAX_IMAGE_SIDE", "8000"))
SESSION_HOURS = float(os.environ.get("VFR_SESSION_HOURS", "12"))
COOKIE_SECURE = os.environ.get("VFR_COOKIE_SECURE", "false").lower() == "true"

ASSET_SUBDIRS = ("original", "processed", "masks", "cutouts", "thumbs")
