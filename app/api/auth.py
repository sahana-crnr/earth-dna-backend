"""`/auth/*` — the 12 routes of src/auth/auth.controller.ts, same status codes
and throttles."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import auth_service, user_agent
from app.core.db import get_session
from app.core.ratelimit import ThrottledRoute, throttle
from app.core.security import JwtPayload, get_current_user
from app.core.validation import body_of
from app.schemas.auth import (
    APPLE_LOGIN,
    FACEBOOK_LOGIN,
    FORGOT_PASSWORD,
    GOOGLE_LOGIN,
    LOGIN,
    REFRESH_TOKEN,
    REGISTER,
    RESET_PASSWORD,
    AppleLoginBody,
    FacebookLoginBody,
    ForgotPasswordBody,
    GoogleLoginBody,
    LoginBody,
    RefreshTokenBody,
    RegisterBody,
    ResetPasswordBody,
)
from app.services.auth import AuthService

router = APIRouter(prefix="/auth", tags=["Auth"], route_class=ThrottledRoute)

_FORM = (
    (Path(__file__).resolve().parent.parent / "templates" / "reset_password_form.html")
    .read_text(encoding="utf-8")
    .rstrip("\n")
)


def reset_password_html(token: str | None) -> str:
    safe = (
        (token or "")
        .replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return _FORM.replace("${safeToken}", safe)


@router.post("/register", status_code=201, summary="Register a new user")
async def register(
    body: RegisterBody = Depends(body_of(REGISTER, RegisterBody)),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
    ua: str | None = Depends(user_agent),
) -> dict[str, Any]:
    return await svc.register(session, body, ua)


@router.post("/login", status_code=200, summary="Sign in with email and password")
@throttle(10, 60000)
async def login(
    body: LoginBody = Depends(body_of(LOGIN, LoginBody)),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
    ua: str | None = Depends(user_agent),
) -> dict[str, Any]:
    return await svc.login(session, body, ua)


@router.post(
    "/refresh", status_code=200, summary="Exchange a refresh token for new tokens"
)
async def refresh(
    body: RefreshTokenBody = Depends(body_of(REFRESH_TOKEN, RefreshTokenBody)),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
    ua: str | None = Depends(user_agent),
) -> dict[str, Any]:
    return await svc.refresh(session, body.refreshToken, ua)


@router.post(
    "/logout", status_code=200, summary="Revoke a single session (refresh token)"
)
async def logout(
    body: RefreshTokenBody = Depends(body_of(REFRESH_TOKEN, RefreshTokenBody)),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
) -> dict[str, str]:
    return await svc.logout(session, body.refreshToken)


@router.post(
    "/logout-all", status_code=200, summary="Revoke all sessions for the current user"
)
async def logout_all(
    user: JwtPayload = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
) -> dict[str, str]:
    return await svc.logout_all(session, user["sub"])


@router.post("/google", status_code=200, summary="Sign in with a Google ID token")
@throttle(20, 60000)
async def google_login(
    body: GoogleLoginBody = Depends(body_of(GOOGLE_LOGIN, GoogleLoginBody)),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
    ua: str | None = Depends(user_agent),
) -> dict[str, Any]:
    return await svc.google_login(session, body, ua)


@router.post("/facebook", status_code=200, summary="Sign in with a Facebook token")
@throttle(20, 60000)
async def facebook_login(
    body: FacebookLoginBody = Depends(body_of(FACEBOOK_LOGIN, FacebookLoginBody)),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
    ua: str | None = Depends(user_agent),
) -> dict[str, Any]:
    return await svc.facebook_login(session, body, ua)


@router.post("/apple", status_code=200, summary="Sign in with an Apple identity token")
@throttle(20, 60000)
async def apple_login(
    body: AppleLoginBody = Depends(body_of(APPLE_LOGIN, AppleLoginBody)),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
    ua: str | None = Depends(user_agent),
) -> dict[str, Any]:
    return await svc.apple_login(session, body, ua)


@router.get("/profile", summary="Get the logged-in user profile")
async def get_profile(
    user: JwtPayload = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
) -> dict[str, Any]:
    return await svc.get_profile(session, user["sub"])


@router.post(
    "/forgot-password", status_code=200, summary="Request a password reset email"
)
@throttle(3, 60000)
async def forgot_password(
    body: ForgotPasswordBody = Depends(body_of(FORGOT_PASSWORD, ForgotPasswordBody)),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
) -> dict[str, str]:
    return await svc.forgot_password(session, body.email)


@router.get("/reset-password", summary="Render the HTML password reset form")
async def reset_password_form(request: Request) -> HTMLResponse:
    return HTMLResponse(reset_password_html(request.query_params.get("token")))


@router.post(
    "/reset-password", status_code=200, summary="Reset password using a valid token"
)
async def reset_password(
    body: ResetPasswordBody = Depends(body_of(RESET_PASSWORD, ResetPasswordBody)),
    session: AsyncSession = Depends(get_session),
    svc: AuthService = Depends(auth_service),
) -> dict[str, str]:
    return await svc.reset_password(
        session, body.token, body.newPassword, body.confirmPassword
    )
