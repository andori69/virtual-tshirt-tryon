from app.security import hash_password, verify_password

from .conftest import PASSWORD


def test_hash_is_salted_and_verifies():
    a, b = hash_password("secret-pass-1"), hash_password("secret-pass-1")
    assert a != b and a.startswith("scrypt$")
    assert verify_password("secret-pass-1", a)
    assert not verify_password("wrong", a)
    assert not verify_password("x", "garbage")


def test_owner_routes_require_login(client):
    for method, path in [("get", "/api/owner/products"), ("post", "/api/owner/products"),
                         ("get", "/api/owner/overview"), ("get", "/api/owner/inventory"),
                         ("get", "/api/owner/settings"), ("get", "/api/owner/calibration"),
                         ("delete", "/api/owner/products/1"), ("get", "/api/auth/me")]:
        assert getattr(client, method)(path).status_code == 401, path


def test_login_wrong_password(client):
    r = client.post("/api/auth/login", json={"username": "owner", "password": "nope"})
    assert r.status_code == 401
    assert "password" in r.json()["detail"].lower()


def test_login_sets_httponly_cookie_and_logout_invalidates(client):
    r = client.post("/api/auth/login", json={"username": "owner", "password": PASSWORD})
    assert r.status_code == 200
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert client.get("/api/auth/me").json() == {"username": "owner"}
    token = client.cookies.get("vfr_session")
    client.post("/api/auth/logout")
    client.cookies.set("vfr_session", token)  # replaying the old token must not work
    assert client.get("/api/auth/me").status_code == 401


def test_login_throttle(client):
    for _ in range(8):
        client.post("/api/auth/login", json={"username": "owner", "password": "bad"})
    r = client.post("/api/auth/login", json={"username": "owner", "password": PASSWORD})
    assert r.status_code == 429


def test_change_password(owner_client):
    r = owner_client.post("/api/auth/change-password", json={"current_password": "bad", "new_password": "x" * 12})
    assert r.status_code == 400
    r = owner_client.post("/api/auth/change-password",
                          json={"current_password": PASSWORD, "new_password": "another long pass"})
    assert r.status_code == 200
    owner_client.post("/api/auth/change-password",
                      json={"current_password": "another long pass", "new_password": PASSWORD})
