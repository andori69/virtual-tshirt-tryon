import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import SQLAlchemyError

from . import config, wardrobe
from .api import auth, calibration, fitting, inventory, products, settings
from .database import init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("vfr")


init_db()  # before mounting: StaticFiles needs the asset directories to exist
wardrobe.scan()  # start processing any new shirt files in the background

app = FastAPI(title="Virtual Fitting Room")
for r in (auth.router, products.router, inventory.router, calibration.router, settings.router, fitting.router):
    app.include_router(r)

# Only derived, non-sensitive garment assets are public; originals are served through an owner route.
for sub in ("processed", "thumbs"):
    app.mount(f"/assets/{sub}", StaticFiles(directory=config.ASSETS_DIR / sub), name=f"assets-{sub}")


@app.exception_handler(SQLAlchemyError)
async def db_error(request: Request, exc: SQLAlchemyError):
    log.exception("database error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "A database error occurred. Please try again."}, status_code=503)


@app.exception_handler(Exception)
async def unexpected(request: Request, exc: Exception):
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "Unexpected server error."}, status_code=500)
