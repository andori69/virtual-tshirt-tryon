"""Upload validation by content: size, real format, decodability, dimensions."""
import io

from PIL import Image, UnidentifiedImageError

from .. import config

ALLOWED_FORMATS = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}
Image.MAX_IMAGE_PIXELS = 40_000_000  # guard against decompression bombs


class ImageValidationError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def validate_image_bytes(data: bytes) -> tuple[str, int, int]:
    """Returns (extension, width, height) or raises ImageValidationError with a user-facing message."""
    max_bytes = int(config.MAX_UPLOAD_MB * 1024 * 1024)
    if not data:
        raise ImageValidationError("The file is empty.")
    if len(data) > max_bytes:
        raise ImageValidationError(f"Image is larger than {config.MAX_UPLOAD_MB:g} MB.", 413)
    try:
        with Image.open(io.BytesIO(data)) as probe:
            fmt = probe.format
            probe.verify()
        if fmt not in ALLOWED_FORMATS:
            raise ImageValidationError(f"Unsupported image format ({fmt}). Use PNG, JPG or WEBP.", 415)
        with Image.open(io.BytesIO(data)) as img:
            img.load()  # full decode catches truncated files that verify() misses
            width, height = img.size
    except ImageValidationError:
        raise
    except Image.DecompressionBombError:
        raise ImageValidationError("Image has too many pixels.", 413)
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise ImageValidationError("The file is not a readable PNG, JPG or WEBP image.", 415)
    if min(width, height) < config.MIN_IMAGE_SIDE:
        raise ImageValidationError(
            f"Image is too small ({width}x{height}). Each side must be at least {config.MIN_IMAGE_SIDE} px."
        )
    if max(width, height) > config.MAX_IMAGE_SIDE:
        raise ImageValidationError(f"Image is too large ({width}x{height}). Max side is {config.MAX_IMAGE_SIDE} px.", 413)
    return ALLOWED_FORMATS[fmt], width, height
