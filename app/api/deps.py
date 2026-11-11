"""Request-scoped access to the services built in `app.main`."""

from __future__ import annotations

from fastapi import Request

from app.services.auth import AuthService


def auth_service(request: Request) -> AuthService:
    return request.app.state.auth  # type: ignore[no-any-return]


def user_agent(request: Request) -> str | None:
    return request.headers.get("user-agent")
