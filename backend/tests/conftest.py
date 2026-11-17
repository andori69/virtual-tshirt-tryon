import io
import os
import tempfile

import pytest

_tmp = tempfile.mkdtemp(prefix="vfr-test-")
os.environ["VFR_ASSETS_DIR"] = os.path.join(_tmp, "assets")
os.environ["VFR_DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["VFR_WARDROBE_DIR"] = os.path.join(_tmp, "Tshirts")
os.makedirs(os.environ["VFR_WARDROBE_DIR"])

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Owner  # noqa: E402
from app.security import hash_password, throttle  # noqa: E402

PASSWORD = "correct horse battery"


@pytest.fixture(scope="session", autouse=True)
def _owner():
    with SessionLocal() as db:
        db.add(Owner(username="owner", password_hash=hash_password(PASSWORD)))
        db.commit()


@pytest.fixture
def client():
    throttle._fails.clear()
    with TestClient(app) as c:
        yield c


@pytest.fixture
def owner_client(client):
    r = client.post("/api/auth/login", json={"username": "owner", "password": PASSWORD})
    assert r.status_code == 200
    return client


def png_bytes(size=(600, 600), color=(200, 200, 200), fmt="PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format=fmt)
    return buf.getvalue()


SIZES = [
    {"label": "S", "chest_width_cm": 48, "shoulder_width_cm": 42, "length_cm": 66, "sleeve_length_cm": 19},
    {"label": "M", "chest_width_cm": 51, "shoulder_width_cm": 44, "length_cm": 69, "sleeve_length_cm": 20},
    {"label": "L", "chest_width_cm": 54, "shoulder_width_cm": 46, "length_cm": 72, "sleeve_length_cm": 21},
]
