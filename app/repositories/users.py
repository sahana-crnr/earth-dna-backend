"""User reads and writes (src/user/user.service.ts)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User


def is_unique_violation(exc: BaseException) -> bool:
    if not isinstance(exc, IntegrityError):
        return False
    orig = exc.orig
    code = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
    return code == "23505"


async def get_password_changed_at(
    session: AsyncSession, user_id: str
) -> datetime | None:
    """`UserService.getPasswordChangedAt`: null when unknown user or never reset."""
    row = await session.execute(
        select(User.password_changed_at).where(User.id == _uuid(user_id))
    )
    return row.scalar_one_or_none()


_NEVER = datetime(1970, 1, 1, tzinfo=UTC)


async def get_auth_state(session: AsyncSession, user_id: str) -> datetime | None:
    """For the JWT guard: None when the user row is gone; otherwise the
    `passwordChangedAt` to compare with the token's iat (epoch when never reset)."""
    row = await session.execute(
        select(User.id, User.password_changed_at).where(User.id == _uuid(user_id))
    )
    found = row.first()
    if found is None:
        return None
    return found[1] or _NEVER


async def get_role(session: AsyncSession, user_id: str) -> str | None:
    row = await session.execute(select(User.role).where(User.id == _uuid(user_id)))
    return row.scalar_one_or_none()


async def find_by_id(session: AsyncSession, user_id: str) -> User | None:
    uid = _uuid(user_id)
    if uid is None:
        return None
    return await session.get(User, uid)


async def find_by_email(session: AsyncSession, email: str) -> User | None:
    """`LOWER(email) = LOWER(:email)` — `_` is literal, not ILIKE."""
    row = await session.execute(
        select(User).where(func.lower(User.email) == func.lower(email)).limit(1)
    )
    return row.scalar_one_or_none()


async def find_by_provider(
    session: AsyncSession, provider: str, provider_user_id: str
) -> User | None:
    row = await session.execute(
        select(User)
        .where(
            User.auth_provider == provider, User.provider_user_id == provider_user_id
        )
        .limit(1)
    )
    return row.scalar_one_or_none()


async def create_local(
    session: AsyncSession,
    *,
    full_name: str,
    email: str,
    password_hash: str,
    country: str,
    country_code: str | None,
    zip_code: str | None,
) -> User:
    user = User(
        full_name=full_name,
        email=email.strip().lower(),
        password=password_hash,
        country=country,
        country_code=country_code,
        zip_code=zip_code,
    )
    nested = await session.begin_nested()
    try:
        session.add(user)
        await session.flush()
        await nested.commit()
    except IntegrityError as exc:
        await nested.rollback()
        if is_unique_violation(exc):
            raise EmailTaken(email) from exc
        raise
    await session.refresh(user)
    return user


class EmailTaken(Exception):
    """Unique violation on users.email during a local registration."""


async def create_social(
    session: AsyncSession,
    *,
    provider: str,
    provider_user_id: str | None,
    email: str,
    full_name: str,
) -> User:
    """Insert, or on a unique clash return the row that won (same provider key,
    else same email) — `UserService.createSocialUser`."""
    user = User(
        email=email.strip().lower(),
        full_name=full_name,
        password=None,
        country=None,
        country_code=None,
        zip_code=None,
        auth_provider=provider,
        provider_user_id=provider_user_id,
    )
    nested = await session.begin_nested()
    try:
        session.add(user)
        await session.flush()
        await nested.commit()
    except IntegrityError as exc:
        await nested.rollback()
        if not is_unique_violation(exc):
            raise
        if provider_user_id:
            by_provider = await find_by_provider(session, provider, provider_user_id)
            if by_provider:
                return by_provider
        by_email = await find_by_email(session, email)
        if by_email:
            return by_email
        raise
    await session.refresh(user)
    return user


async def set_reset_token(
    session: AsyncSession, user_id: uuid.UUID, hashed_token: str, expiry: datetime
) -> None:
    await session.execute(
        update(User)
        .where(User.id == user_id)
        .values(reset_password_token=hashed_token, reset_password_expiry=expiry)
    )


async def clear_reset_token(
    session: AsyncSession, user_id: uuid.UUID, hashed_token: str | None = None
) -> None:
    stmt = update(User).where(User.id == user_id)
    if hashed_token is not None:
        stmt = stmt.where(User.reset_password_token == hashed_token)
    await session.execute(
        stmt.values(reset_password_token=None, reset_password_expiry=None)
    )


async def consume_reset_token(
    session: AsyncSession, hashed_token: str, hashed_password: str
) -> uuid.UUID | None:
    """One UPDATE guarded by token + expiry: exactly one of two concurrent
    resets can win. Stamps `passwordChangedAt` so older access tokens die."""
    row = await session.execute(
        update(User)
        .where(
            User.reset_password_token == hashed_token,
            User.reset_password_expiry > func.now(),
        )
        .values(
            password=hashed_password,
            reset_password_token=None,
            reset_password_expiry=None,
            password_changed_at=func.now(),
        )
        .returning(User.id)
    )
    return row.scalar_one_or_none()


async def update_fields(
    session: AsyncSession, user_id: uuid.UUID, **values: Any
) -> None:
    if values:
        await session.execute(update(User).where(User.id == user_id).values(**values))


async def demote_admins_except(session: AsyncSession, keep_id: uuid.UUID | None) -> int:
    stmt = update(User).where(User.role == "ADMIN").values(role="USER")
    if keep_id is not None:
        stmt = stmt.where(User.id != keep_id)
    res = await session.execute(stmt)
    return int(getattr(res, "rowcount", 0) or 0)


async def lock_user_row(session: AsyncSession, user_id: uuid.UUID) -> None:
    """`SELECT id FROM users WHERE id = :id FOR UPDATE` — serialises rotations."""
    await session.execute(select(User.id).where(User.id == user_id).with_for_update())


async def advisory_xact_lock(session: AsyncSession, key: int) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None
