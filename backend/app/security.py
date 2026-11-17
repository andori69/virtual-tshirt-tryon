"""Password hashing (stdlib scrypt) and cookie-based owner sessions stored server-side."""
import hashlib
import hmac
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import config
from .database import get_db
from .models import Owner, OwnerSession

COOKIE_NAME = "vfr_session"
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(candidate.hex(), digest)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: Session, owner: Owner) -> str:
    token = secrets.token_urlsafe(32)
    db.execute(delete(OwnerSession).where(OwnerSession.expires_at < datetime.now(timezone.utc)))
    db.add(OwnerSession(
        token_hash=_token_hash(token),
        owner_id=owner.id,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=config.SESSION_HOURS),
    ))
    db.commit()
    return token


def destroy_session(db: Session, token: str | None) -> None:
    if token:
        db.execute(delete(OwnerSession).where(OwnerSession.token_hash == _token_hash(token)))
        db.commit()


def current_owner(request: Request, db: Session = Depends(get_db)) -> Owner:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(401, "Sign in required.")
    sess = db.scalar(select(OwnerSession).where(OwnerSession.token_hash == _token_hash(token)))
    if sess is None or sess.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(401, "Session expired. Please sign in again.")
    return sess.owner


class LoginThrottle:
    """In-memory brute-force guard: after `limit` failures a username is locked for `lock_s` seconds."""

    def __init__(self, limit: int = 8, lock_s: float = 300):
        self.limit, self.lock_s = limit, lock_s
        self._fails: dict[str, list[float]] = {}

    def check(self, username: str) -> None:
        now = time.monotonic()
        recent = [t for t in self._fails.get(username, []) if now - t < self.lock_s]
        self._fails[username] = recent
        if len(recent) >= self.limit:
            raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")

    def fail(self, username: str) -> None:
        self._fails.setdefault(username, []).append(time.monotonic())

    def reset(self, username: str) -> None:
        self._fails.pop(username, None)


throttle = LoginThrottle()
