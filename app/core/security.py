"""Access tokens and role checks: the NestJS `JwtAuthGuard` and `RolesGuard`.

Same algorithm (HS256), same secret, same claims (`sub`, `email`, `role?`,
`iat`, `exp`), so a token signed by the Node service is accepted here and the
other way round during the switch. Same error strings.
"""

from __future__ import annotations

import math
import uuid
from collections.abc import Callable, Coroutine
from datetime import datetime
from typing import Any, Literal, TypedDict

import jwt
from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import forbidden_role, unauthorized
from app.core.settings import Settings
from app.repositories import users as users_repo

UserRole = Literal["USER", "ADMIN"]
USER_ROLES: tuple[UserRole, ...] = ("USER", "ADMIN")
DEFAULT_USER_ROLE: UserRole = "USER"

MISSING_TOKEN = "Missing access token"  # noqa: S105
INVALID_TOKEN = "Invalid or expired token"  # noqa: S105


class JwtPayload(TypedDict, total=False):
    sub: str
    email: str
    role: UserRole
    iat: int
    exp: int


def bearer_token(authorization: str | None) -> str | None:
    """`extractTokenFromHeader`: `Bearer <token>` or nothing."""
    if not authorization:
        return None
    parts = authorization.split(" ")
    if len(parts) < 2 or parts[0] != "Bearer":
        return None
    return parts[1] or None


def decode_access_token(token: str, settings: Settings) -> JwtPayload:
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=["HS256"],
            options={"require": ["sub", "exp", "iat"], "verify_aud": False},
        )
    except jwt.PyJWTError as exc:
        raise unauthorized(INVALID_TOKEN) from exc
    return payload  # type: ignore[return-value]


def token_predates_reset(iat: int | None, changed_at: datetime | None) -> bool:
    """Node: `(payload.iat ?? 0) < Math.floor(changedAt.getTime() / 1000)`.

    Second precision on both sides, so the login right after a reset (same
    second) is still accepted.
    """
    if changed_at is None:
        return False
    return (iat or 0) < math.floor(changed_at.timestamp())


def app_settings(request: Request) -> Settings:
    """The settings the running app was created with (not the process default)."""
    return request.app.state.settings  # type: ignore[no-any-return]


async def get_current_user(
    request: Request,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(app_settings),
) -> JwtPayload:
    token = bearer_token(request.headers.get("authorization"))
    if not token:
        raise unauthorized(MISSING_TOKEN)
    payload = decode_access_token(token, settings)
    try:
        uuid.UUID(str(payload["sub"]))
    except (ValueError, TypeError) as exc:
        raise unauthorized(INVALID_TOKEN) from exc
    state = await users_repo.get_auth_state(session, payload["sub"])
    if state is None:
        # the account no longer exists: its tokens are dead, whatever their exp
        raise unauthorized(INVALID_TOKEN)
    if token_predates_reset(payload.get("iat"), state):
        raise unauthorized(INVALID_TOKEN)
    request.state.user = payload
    return payload


def require_roles(
    *roles: UserRole,
) -> Callable[..., Coroutine[Any, Any, JwtPayload]]:
    """`@Roles('ADMIN')` + RolesGuard: the role is read from the DB, not the token."""

    async def dependency(
        user: JwtPayload = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
    ) -> JwtPayload:
        if not roles:
            return user
        role = await users_repo.get_role(session, user["sub"])
        if role is None or role not in roles:
            raise forbidden_role()
        return user

    return dependency
