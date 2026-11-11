"""F7 model integrations (src/integrations): ShoeDNA / ValueLens endpoint
settings edited by the admin, and the Secrets Manager credential resolver."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any

from botocore.config import Config
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.aws import boto_session
from app.core.errors import ApiError
from app.core.settings import Settings
from app.core.time import to_js_iso
from app.models.integration import Integration
from app.models.user import User

log = logging.getLogger("app.integrations")

INTEGRATION_NAMES: tuple[str, ...] = ("shoedna", "valuelens")
NULLABLE = ("baseUrl", "version", "authRef")


def is_integration_name(v: str) -> bool:
    return v in INTEGRATION_NAMES


@dataclass(frozen=True)
class IntegrationSettings:
    base_url: str | None
    version: str | None
    auth_ref: str | None
    enabled: bool


def apply_update(
    current: IntegrationSettings, patch: dict[str, Any]
) -> IntegrationSettings:
    """absent keeps, null clears, a value replaces; `enabled: null` keeps."""
    base_url = patch.get("baseUrl", current.base_url)
    version = patch.get("version", current.version)
    auth_ref = patch.get("authRef", current.auth_ref)
    enabled = current.enabled
    if patch.get("enabled") is not None:
        enabled = bool(patch["enabled"])
    return IntegrationSettings(base_url, version, auth_ref, enabled)


def incomplete_reason(s: IntegrationSettings) -> str | None:
    if s.enabled and not s.base_url:
        return "An integration cannot be enabled without a baseUrl"
    return None


def not_found(name: str) -> ApiError:
    return ApiError(
        404,
        "INTEGRATION_NOT_FOUND",
        f'Unknown integration "{name}"',
        {"known": list(INTEGRATION_NAMES)},
    )


@dataclass(frozen=True)
class ActiveIntegration:
    name: str
    base_url: str
    version: str | None
    auth_ref: str | None


class IntegrationsService:
    async def list(self, session: AsyncSession) -> dict[str, Any]:
        await self._ensure_rows(session)
        rows = await session.execute(
            select(Integration, User.email)
            .outerjoin(User, User.id == Integration.updated_by_id)
            .order_by(Integration.name.asc())
        )
        items = [self._view(row, email) for row, email in rows.all()]
        await session.commit()
        return {"items": items}

    async def update(
        self,
        session: AsyncSession,
        name: str,
        patch: dict[str, Any],
        admin_id: uuid.UUID,
    ) -> dict[str, Any]:
        if not is_integration_name(name):
            raise not_found(name)
        await self._ensure_rows(session)
        row = (
            await session.execute(
                select(Integration).where(Integration.name == name).with_for_update()
            )
        ).scalar_one_or_none()
        if row is None:
            raise not_found(name)
        current = IntegrationSettings(
            row.base_url, row.version, row.auth_ref, row.enabled
        )
        nxt = apply_update(current, patch)
        reason = incomplete_reason(nxt)
        if reason:
            raise ApiError(409, "INTEGRATION_INCOMPLETE", reason, {"name": name})
        if nxt != current:
            await session.execute(
                update(Integration)
                .where(Integration.name == name)
                .values(
                    base_url=nxt.base_url,
                    version=nxt.version,
                    auth_ref=nxt.auth_ref,
                    enabled=nxt.enabled,
                    updated_by_id=admin_id,
                )
            )
        session.expire_all()
        saved = (
            await session.execute(
                select(Integration, User.email)
                .outerjoin(User, User.id == Integration.updated_by_id)
                .where(Integration.name == name)
            )
        ).one()
        view = self._view(saved[0], saved[1])
        await session.commit()
        return view

    async def get_active(
        self, session: AsyncSession, name: str
    ) -> ActiveIntegration | None:
        row = (
            await session.execute(
                select(Integration).where(
                    Integration.name == name, Integration.enabled.is_(True)
                )
            )
        ).scalar_one_or_none()
        if row is None or not row.base_url:
            return None
        return ActiveIntegration(row.name, row.base_url, row.version, row.auth_ref)

    async def _ensure_rows(self, session: AsyncSession) -> None:
        await session.execute(
            pg_insert(Integration)
            .values([{"name": n} for n in INTEGRATION_NAMES])
            .on_conflict_do_nothing(index_elements=["name"])
        )

    @staticmethod
    def _view(row: Integration, email: str | None) -> dict[str, Any]:
        return {
            "name": row.name,
            "baseUrl": row.base_url,
            "version": row.version,
            "authRef": row.auth_ref,
            "enabled": row.enabled,
            "updatedAt": to_js_iso(row.updated_at),
            "updatedBy": {"id": str(row.updated_by_id), "email": email}
            if row.updated_by_id is not None and email is not None
            else None,
        }


# ─── secrets ─────────────────────────────────────────────────────────────────
class SecretUnavailableError(Exception):
    def __init__(self, name: str) -> None:
        super().__init__(f"secret {name} could not be read")


CACHE_S = 5 * 60


def extract_key(secret: str | None) -> str | None:
    s = (secret or "").strip()
    if not s:
        return None
    if not s.startswith("{"):
        return s
    try:
        parsed = json.loads(s)
    except ValueError:
        return None
    key = parsed.get("apiKey") if isinstance(parsed, dict) else None
    return key.strip() if isinstance(key, str) and key.strip() else None


class AwsSecretResolver:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Any | None = None
        self._cache: dict[str, tuple[str, float]] = {}

    def _sm(self) -> Any:
        if self._client is None:
            self._client = boto_session(self._settings).client(
                "secretsmanager",
                config=Config(
                    connect_timeout=3, read_timeout=5, retries={"max_attempts": 2}
                ),
            )
        return self._client

    async def resolve(self, name: str) -> str:
        hit = self._cache.get(name)
        if hit and hit[1] > time.monotonic():
            return hit[0]
        try:
            out = await asyncio.to_thread(self._sm().get_secret_value, SecretId=name)
            value = extract_key(out.get("SecretString"))
        except Exception as exc:
            log.error("GetSecretValue %s failed: %s", name, exc)
            raise SecretUnavailableError(name) from exc
        if not value:
            log.error("secret %s is empty or has no apiKey field", name)
            raise SecretUnavailableError(name)
        self._cache[name] = (value, time.monotonic() + CACHE_S)
        return value
