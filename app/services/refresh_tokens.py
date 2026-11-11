"""Opaque, rotating refresh tokens (src/auth/refresh-token.service.ts).

Only the SHA-256 of a token is stored. Rotation revokes the presented token and
issues a new one inside one transaction, serialised per user with a row lock;
presenting an already-rotated token is treated as theft and ends every session
of that user.

Sessions autobegin on first use, so these methods never call `session.begin()`;
they `commit()` what must survive a raised error and leave the rest to the
caller.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import uuid
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.durations import parse_ms
from app.core.errors import unauthorized
from app.core.settings import Settings
from app.core.time import utcnow
from app.models.user import RefreshToken
from app.repositories import users as users_repo

log = logging.getLogger("app.auth.refresh")

INVALID = "Invalid refresh token"
EXPIRED = "Refresh token expired"


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def new_raw_token() -> str:
    return secrets.token_hex(32)


class RefreshTokenService:
    def __init__(self, settings: Settings) -> None:
        self._lifetime = timedelta(
            milliseconds=parse_ms(settings.REFRESH_TOKEN_EXPIRES_IN)
        )

    async def issue(
        self, session: AsyncSession, user_id: uuid.UUID, user_agent: str | None
    ) -> str:
        _, raw = await self._create(session, user_id, user_agent)
        return raw

    async def _create(
        self, session: AsyncSession, user_id: uuid.UUID, user_agent: str | None
    ) -> tuple[RefreshToken, str]:
        raw = new_raw_token()
        row = RefreshToken(
            user_id=user_id,
            token_hash=hash_token(raw),
            expires_at=utcnow() + self._lifetime,
            user_agent=user_agent,
        )
        session.add(row)
        await session.flush()
        return row, raw

    async def rotate(
        self, session: AsyncSession, raw: str, user_agent: str | None
    ) -> tuple[uuid.UUID, str]:
        """Revoke `raw`, issue a replacement; commits. Raises 401 on any doubt."""
        token_hash = hash_token(raw)
        record = (
            await session.execute(
                select(RefreshToken).where(RefreshToken.token_hash == token_hash)
            )
        ).scalar_one_or_none()
        if record is None:
            raise unauthorized(INVALID)
        if record.revoked_at is not None:
            if record.replaced_by_token_id is not None:
                log.warning(
                    "Refresh token reuse detected for user %s; revoking all sessions",
                    record.user_id,
                )
                await self.revoke_all_for_user(session, record.user_id)
                await session.commit()
            raise unauthorized(INVALID)
        if record.expires_at <= utcnow():
            raise unauthorized(EXPIRED)

        # Row lock on the user serialises concurrent rotations; the guarded
        # UPDATE makes exactly one of them win.
        await users_repo.lock_user_row(session, record.user_id)
        claimed = await session.execute(
            update(RefreshToken)
            .where(RefreshToken.id == record.id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=func.now())
        )
        if not int(getattr(claimed, "rowcount", 0) or 0):
            # Lost the race: another request rotated this token meanwhile. If
            # that rotation already produced a replacement, this is a reuse —
            # the same theft signal as above, so every session goes.
            await session.refresh(record)
            if record.replaced_by_token_id is not None:
                log.warning(
                    "Refresh token reuse detected (race) for user %s; revoking all sessions",
                    record.user_id,
                )
                await self.revoke_all_for_user(session, record.user_id)
                await session.commit()
            raise unauthorized(INVALID)
        new_row, new_raw = await self._create(session, record.user_id, user_agent)
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.id == record.id)
            .values(replaced_by_token_id=new_row.id)
        )
        await session.commit()
        return record.user_id, new_raw

    async def revoke(self, session: AsyncSession, raw: str) -> None:
        await session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.token_hash == hash_token(raw),
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=utcnow())
        )

    async def revoke_all_for_user(
        self, session: AsyncSession, user_id: uuid.UUID
    ) -> None:
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=utcnow())
        )
