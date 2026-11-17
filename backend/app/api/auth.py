from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import config
from ..database import get_db
from ..models import Owner
from ..schemas import ChangePasswordIn, LoginIn
from ..security import (COOKIE_NAME, create_session, current_owner, destroy_session, hash_password, throttle,
                        verify_password)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    throttle.check(body.username)
    owner = db.scalar(select(Owner).where(Owner.username == body.username))
    if owner is None or not verify_password(body.password, owner.password_hash):
        throttle.fail(body.username)
        raise HTTPException(401, "Incorrect username or password.")
    throttle.reset(body.username)
    token = create_session(db, owner)
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, samesite="strict", secure=config.COOKIE_SECURE,
        max_age=int(config.SESSION_HOURS * 3600), path="/",
    )
    return {"username": owner.username}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    destroy_session(db, request.cookies.get(COOKIE_NAME))
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(owner: Owner = Depends(current_owner)):
    return {"username": owner.username}


@router.post("/change-password")
def change_password(body: ChangePasswordIn, owner: Owner = Depends(current_owner), db: Session = Depends(get_db)):
    if not verify_password(body.current_password, owner.password_hash):
        raise HTTPException(400, "Current password is incorrect.")
    owner = db.merge(owner)
    owner.password_hash = hash_password(body.new_password)
    db.commit()
    return {"ok": True}
