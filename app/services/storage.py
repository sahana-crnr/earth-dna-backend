"""Photo object storage (src/storage): S3 (or the local emulator) behind a
small interface, plus the error-mapping helpers the services share."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol

from botocore.config import Config

from app.core.aws import boto_session
from app.core.errors import ApiError
from app.core.settings import Settings
from app.services.scan_rules import FileInfo, Limits, check_photo, sniff_image_type

log = logging.getLogger("app.storage")


class StorageUnavailableError(Exception):
    def __init__(self, operation: str, cause: BaseException | None = None) -> None:
        super().__init__(f"storage {operation} failed")
        self.__cause__ = cause


class StorageNotConfiguredError(Exception):
    def __init__(self) -> None:
        super().__init__("photo storage is not configured")


class PhotoStorage(Protocol):
    def is_configured(self) -> bool: ...

    async def put(self, key: str, body: bytes, content_type: str) -> None: ...

    async def delete(self, key: str) -> None: ...

    async def signed_get_url(self, key: str, ttl_seconds: int) -> str: ...


class S3PhotoStorage:
    """SHOE_PHOTOS_BUCKET unset → not configured; /scans routes answer 503."""

    def __init__(self, settings: Settings) -> None:
        self._bucket = settings.SHOE_PHOTOS_BUCKET
        self._client: Any | None = None
        self._signer: Any | None = None
        if self._bucket:
            session = boto_session(settings)
            cfg = Config(
                signature_version="s3v4",
                s3={
                    "addressing_style": "path"
                    if settings.STORAGE_S3_FORCE_PATH_STYLE
                    else "auto"
                },
                connect_timeout=5,
                read_timeout=15,
                retries={"max_attempts": 2},
            )

            def make(endpoint: str | None) -> Any:
                kwargs: dict[str, Any] = {
                    "config": cfg,
                    "region_name": settings.AWS_REGION,
                }
                if endpoint:
                    kwargs.update(
                        endpoint_url=endpoint,
                        aws_access_key_id=settings.STORAGE_S3_ACCESS_KEY,
                        aws_secret_access_key=settings.STORAGE_S3_SECRET_KEY,
                    )
                return session.client("s3", **kwargs)

            self._client = make(settings.STORAGE_S3_ENDPOINT)
            self._signer = (
                make(settings.STORAGE_S3_PUBLIC_ENDPOINT)
                if settings.STORAGE_S3_PUBLIC_ENDPOINT
                else self._client
            )
        else:
            log.warning("SHOE_PHOTOS_BUCKET is not set — /scans routes will answer 503")

    def is_configured(self) -> bool:
        return self._client is not None

    def _require(self) -> Any:
        if self._client is None:
            raise StorageNotConfiguredError()
        return self._client

    async def put(self, key: str, body: bytes, content_type: str) -> None:
        client = self._require()
        try:
            await asyncio.to_thread(
                client.put_object,
                Bucket=self._bucket,
                Key=key,
                Body=body,
                ContentType=content_type,
            )
        except Exception as exc:
            log.error("put %s failed: %r", key, exc)
            raise StorageUnavailableError("put", exc) from exc

    async def delete(self, key: str) -> None:
        client = self._require()
        try:
            await asyncio.to_thread(client.delete_object, Bucket=self._bucket, Key=key)
        except Exception as exc:
            log.error("delete %s failed: %r", key, exc)
            raise StorageUnavailableError("delete", exc) from exc

    async def signed_get_url(self, key: str, ttl_seconds: int) -> str:
        self._require()
        try:
            url: str = await asyncio.to_thread(
                self._signer.generate_presigned_url,  # type: ignore[union-attr]
                "get_object",
                Params={"Bucket": self._bucket, "Key": key},
                ExpiresIn=ttl_seconds,
            )
            return url
        except Exception as exc:
            log.error("sign %s failed: %r", key, exc)
            raise StorageUnavailableError("sign", exc) from exc


class MemoryPhotoStorage:
    """Test double: keeps objects in a dict, can be told to fail."""

    def __init__(self, configured: bool = True) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.configured = configured
        self.fail_put = False

    def is_configured(self) -> bool:
        return self.configured

    async def put(self, key: str, body: bytes, content_type: str) -> None:
        if not self.configured:
            raise StorageNotConfiguredError()
        if self.fail_put:
            raise StorageUnavailableError("put")
        self.objects[key] = (body, content_type)

    async def delete(self, key: str) -> None:
        if not self.configured:
            raise StorageNotConfiguredError()
        self.objects.pop(key, None)

    async def signed_get_url(self, key: str, ttl_seconds: int) -> str:
        if not self.configured:
            raise StorageNotConfiguredError()
        return f"memory://{key}?ttl={ttl_seconds}"


# ─── shared ops (src/storage/photo-storage.ops.ts) ──────────────────────────
def require_storage(storage: PhotoStorage) -> None:
    if not storage.is_configured():
        raise ApiError(503, "STORAGE_NOT_CONFIGURED", "Photo storage is not available")


async def put_or_throw(
    storage: PhotoStorage, key: str, body: bytes, content_type: str
) -> None:
    try:
        await storage.put(key, body, content_type)
    except Exception as exc:
        if isinstance(exc, StorageNotConfiguredError):
            require_storage(storage)
        log.error("put %s failed: %s", key, exc)
        raise ApiError(
            502, "STORAGE_UNAVAILABLE", "Photo storage failed, try again"
        ) from exc


async def safe_delete(storage: PhotoStorage, key: str) -> None:
    try:
        await storage.delete(key)
    except Exception as exc:
        log.warning("could not delete %s: %s", key, exc)


async def sign_or_null(storage: PhotoStorage, key: str, ttl_seconds: int) -> str | None:
    if not storage.is_configured():
        return None
    try:
        return await storage.signed_get_url(key, ttl_seconds)
    except Exception as exc:
        log.warning("could not sign %s: %s", key, exc)
        return None


# ─── upload validation (src/storage/photo-upload.rules.ts) ───────────────────
def validate_uploaded_photo(data: bytes | None, limits: Limits) -> str:
    """Returns the sniffed type or raises the Node ApiErrors."""
    file_type = sniff_image_type(data) if data is not None else None
    rejection = check_photo(
        FileInfo(size=len(data), type=file_type) if data is not None else None, limits
    )
    if rejection == "FILE_REQUIRED":
        raise ApiError(400, "FILE_REQUIRED", "A photo file is required")
    if rejection == "FILE_TOO_LARGE":
        raise ApiError(
            413,
            "FILE_TOO_LARGE",
            f"Photo must be at most {limits.photo_max_bytes} bytes",
        )
    if rejection == "UNSUPPORTED_TYPE":
        raise ApiError(
            415,
            "UNSUPPORTED_TYPE",
            f"Photo must be one of: {', '.join(limits.allowed_types)}",
        )
    assert file_type is not None
    return file_type
