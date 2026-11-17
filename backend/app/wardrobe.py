"""Shirt folder ("wardrobe"): every image in ./Tshirts becomes a try-on garment.

- Files are only ever read. Results go to ./Tshirts/.cache/<key>.json plus <key>.garment.png and <key>.thumb.png,
  where <key> is a hash of the file contents (renames reuse the cache; edited files are re-processed).
- Scanning is cheap (stat + cached hash by path/size/mtime). New files are processed on one background thread so
  requests never wait for background removal.
"""
import hashlib
import json
import logging
import os
import queue
import re
import threading
import time
from pathlib import Path

import numpy as np

from . import config
from .image_processing import pipeline
from .image_processing.garment_mesh import build_mesh
from .image_processing.attributes import extract_attributes
from .image_processing.validation import ImageValidationError, validate_image_bytes

log = logging.getLogger(__name__)

EXTS = {".png", ".jpg", ".jpeg", ".webp"}
CACHE_VERSION = 7  # 2: front/back split; 3: defringed edges; 4: photo mesh; 5: full cuff openings; 6: chest-normalised depth; 7: cuff detection
KEY_RE = re.compile(r"^[0-9a-f]{16}$")

WARDROBE_DIR = Path(os.environ.get("VFR_WARDROBE_DIR", config.BACKEND_DIR.parent / "Tshirts")).resolve()


def cache_dir() -> Path:
    return WARDROBE_DIR / ".cache"


def label_for(filename: str) -> str:
    stem = Path(filename).stem
    return re.sub(r"\s+", " ", re.sub(r"[_-]+", " ", stem)).strip().title() or stem


_hash_memo: dict[tuple[str, int, int], str] = {}
_queue: "queue.Queue[tuple[str, Path]]" = queue.Queue()
_pending: set[str] = set()
_lock = threading.Lock()
_worker: threading.Thread | None = None


def _key(path: Path) -> str:
    st = path.stat()
    memo = (str(path), st.st_size, st.st_mtime_ns)
    if memo not in _hash_memo:
        _hash_memo[memo] = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    return _hash_memo[memo]


def _read_meta(key: str) -> dict | None:
    p = cache_dir() / f"{key}.json"
    try:
        meta = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    return meta if meta.get("version") == CACHE_VERSION else None


def _write_json(key: str, data: dict) -> None:
    tmp = cache_dir() / f"{key}.json.tmp"
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(cache_dir() / f"{key}.json")


def process_file(key: str, path: Path) -> dict:
    """Runs the full pipeline for one shirt file and writes its cache entry. Never touches `path`."""
    started = time.perf_counter()
    base = {"version": CACHE_VERSION, "key": key, "source_file": path.name}
    try:
        validate_image_bytes(path.read_bytes())
        # A photo holding the front above the back yields both; the back is optional.
        parts = pipeline.split_stacked(pipeline.open_original(path))
        assets = pipeline.process_image(parts[0])
        back = None
        if len(parts) > 1:
            try:
                back = pipeline.process_image(parts[1])
            except pipeline.GarmentProcessingError:
                log.warning("back view of %s could not be processed; using the front only", path.name)
    except (ImageValidationError, pipeline.GarmentProcessingError) as e:
        meta = {**base, "status": "failed", "error": str(e)}
        _write_json(key, meta)
        return meta
    except Exception:
        log.exception("wardrobe processing failed for %s", path.name)
        meta = {**base, "status": "failed", "error": "Processing failed unexpectedly. Try a clearer photo."}
        _write_json(key, meta)
        return meta
    assets.processed.save(cache_dir() / f"{key}.garment.png", optimize=True)
    assets.thumb.save(cache_dir() / f"{key}.thumb.png", optimize=True)
    if back:
        back.processed.save(cache_dir() / f"{key}.back.png", optimize=True)
    has_mesh = False
    if assets.anchors:
        try:
            mesh = build_mesh(np.array(assets.processed), assets.anchors,
                              np.array(back.processed) if back else None, back.anchors if back else None)
            (cache_dir() / f"{key}.mesh.json").write_text(json.dumps(mesh))
            has_mesh = True
        except Exception:  # the kiosk falls back to the procedural shirt
            log.exception("mesh build failed for %s", path.name)
    meta = {
        **base,
        "status": "ready",
        "has_back": back is not None,
        "has_mesh": has_mesh,
        "anchors": assets.anchors,
        "attributes": extract_attributes(np.array(assets.processed), assets.anchors),
        "warnings": assets.meta.get("warnings", []),
        "processing_ms": round((time.perf_counter() - started) * 1000),
    }
    if not assets.anchors:
        meta["status"] = "failed"
        meta["error"] = "The shirt outline was found, but its shoulders and hem could not be located."
    _write_json(key, meta)
    return meta


def _work() -> None:
    while True:
        key, path = _queue.get()
        try:
            process_file(key, path)
        finally:
            with _lock:
                _pending.discard(key)
            _queue.task_done()


def _ensure_worker() -> None:
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_work, name="wardrobe", daemon=True)
        _worker.start()


def scan() -> list[dict]:
    """Lists shirts in the folder, queueing any that have no up-to-date cache entry."""
    if not WARDROBE_DIR.is_dir():
        return []
    cache_dir().mkdir(exist_ok=True)
    items = []
    for path in sorted(WARDROBE_DIR.iterdir(), key=lambda p: p.name.lower()):
        if path.name.startswith(".") or not path.is_file() or path.suffix.lower() not in EXTS:
            continue
        try:
            key = _key(path)
        except OSError:
            continue
        meta = _read_meta(key)
        if meta is None:
            with _lock:
                if key not in _pending:
                    _pending.add(key)
                    _queue.put((key, path))
            _ensure_worker()
            meta = {"key": key, "status": "processing"}
        items.append({
            "id": key,
            "file": path.name,
            "label": label_for(path.name),
            "status": meta["status"],
            "error": meta.get("error"),
            "garment_url": f"/api/wardrobe/{key}/garment.png" if meta["status"] == "ready" else None,
            "thumb_url": f"/api/wardrobe/{key}/thumb.png" if meta["status"] == "ready" else None,
            "back_url": f"/api/wardrobe/{key}/back.png" if meta["status"] == "ready" and meta.get("has_back") else None,
            "mesh_url": f"/api/wardrobe/{key}/mesh.json" if meta["status"] == "ready" and meta.get("has_mesh") else None,
            "anchors": meta.get("anchors"),
            "attributes": meta.get("attributes"),
        })
    return items


def asset_path(key: str, kind: str) -> Path | None:
    if not KEY_RE.match(key) or kind not in ("garment", "thumb", "back", "mesh"):
        return None
    p = cache_dir() / (f"{key}.mesh.json" if kind == "mesh" else f"{key}.{kind}.png")
    return p if p.is_file() else None


def wait_idle(timeout: float = 120) -> None:
    """Test helper: block until queued shirts are processed."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        with _lock:
            if not _pending:
                return
        time.sleep(0.05)
