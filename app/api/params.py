"""Path-parameter pipes with Nest's exact rejections."""

from __future__ import annotations

import uuid
from collections.abc import Callable

from fastapi import Request

from app.core.constants import SHOE_VIEWS, is_shoe_view
from app.core.errors import ApiError

UUID_V4_MESSAGE = "Validation failed (uuid v 4 is expected)"


def uuid_param(name: str) -> Callable[[Request], uuid.UUID]:
    """`ParseUUIDPipe({version: '4'})`: 400 with Nest's message, no code."""

    def dependency(request: Request) -> uuid.UUID:
        raw = request.path_params.get(name, "")
        try:
            value = uuid.UUID(str(raw))
        except ValueError as exc:
            raise ApiError(400, None, UUID_V4_MESSAGE) from exc
        if value.version != 4:
            raise ApiError(400, None, UUID_V4_MESSAGE)
        return value

    return dependency


def shoe_view_param(request: Request) -> str:
    """`ShoeViewPipe`: 400 INVALID_VIEW."""
    raw = str(request.path_params.get("view", ""))
    if not is_shoe_view(raw):
        raise ApiError(
            400, "INVALID_VIEW", f"view must be one of: {', '.join(SHOE_VIEWS)}"
        )
    return raw


def user_uuid(sub: str) -> uuid.UUID:
    return uuid.UUID(sub)
