"""Sign-up, sign-in, sessions, social sign-in, password reset (src/auth/auth.service.ts).

Every public method takes the request's `AsyncSession` and commits what it
writes; the session dependency rolls back anything left over.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import time
import uuid
from datetime import timedelta
from typing import Any

import jwt
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.durations import parse_seconds
from app.core.errors import ApiError, unauthorized
from app.core.passwords import hash_password_async, verify_password_async
from app.core.settings import Settings
from app.core.time import utcnow
from app.models.user import User
from app.repositories import users as users_repo
from app.schemas.auth import (
    AppleLoginBody,
    FacebookLoginBody,
    GoogleLoginBody,
    LoginBody,
    RegisterBody,
)
from app.schemas.user import user_view
from app.services.mail import MailService
from app.services.refresh_tokens import RefreshTokenService
from app.services.social.apple import AppleTokenVerifier
from app.services.social.facebook import FacebookTokenVerifier
from app.services.social.google import GoogleTokenVerifier
from app.services.social.identity import SocialIdentity

log = logging.getLogger("app.auth")

FORGOT_PASSWORD_MESSAGE = (
    "If an account with that email exists, a password reset link has been sent."  # noqa: S105
)
RESET_PASSWORD_MESSAGE = (
    "Your password has been reset successfully. "  # noqa: S105
    "You may now log in with your new password."
)
INVALID_CREDENTIALS = "Invalid email or password"
EMAIL_EXISTS = "An account with this email already exists"
LOGGED_OUT = "Logged out successfully."
LOGGED_OUT_ALL = "Logged out of all sessions successfully."


def hash_reset_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class AuthService:
    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        refresh_tokens: RefreshTokenService,
        mail: MailService,
        google: GoogleTokenVerifier,
        facebook: FacebookTokenVerifier,
        apple: AppleTokenVerifier,
    ) -> None:
        self._settings = settings
        self._sessions = session_factory
        self._refresh = refresh_tokens
        self._mail = mail
        self._google = google
        self._facebook = facebook
        self._apple = apple
        self._access_ttl = parse_seconds(settings.JWT_EXPIRES_IN)
        self._background: set[asyncio.Task[None]] = set()

    # ─── tokens ──────────────────────────────────────────────────────────────
    def sign_access_token(self, user: User) -> str:
        now = int(time.time())
        payload: dict[str, Any] = {
            "sub": str(user.id),
            "email": user.email,
            "role": user.role,
            "iat": now,
            "exp": now + self._access_ttl,
        }
        return jwt.encode(payload, self._settings.JWT_SECRET, algorithm="HS256")

    async def _issue_tokens(
        self, session: AsyncSession, user: User, user_agent: str | None
    ) -> dict[str, Any]:
        access = self.sign_access_token(user)
        refresh = await self._refresh.issue(session, user.id, user_agent)
        return {"accessToken": access, "refreshToken": refresh, "user": user_view(user)}

    async def _issue_social_tokens(
        self, session: AsyncSession, user: User, user_agent: str | None
    ) -> dict[str, Any]:
        if user.role == "ADMIN":
            raise ApiError(
                403,
                "ADMIN_PASSWORD_LOGIN_ONLY",
                "This account must sign in with email and password",
            )
        return await self._issue_tokens(session, user, user_agent)

    def _is_admin_email(self, email: str) -> bool:
        admin = (self._settings.ADMIN_EMAIL or "").strip().lower()
        return bool(admin) and admin == email.strip().lower()

    # ─── register / login / sessions ────────────────────────────────────────
    async def register(
        self, session: AsyncSession, body: RegisterBody, user_agent: str | None
    ) -> dict[str, Any]:
        existing = await users_repo.find_by_email(session, body.email)
        if existing is not None or self._is_admin_email(body.email):
            raise ApiError(409, None, EMAIL_EXISTS)
        hashed = await hash_password_async(body.password)
        try:
            user = await users_repo.create_local(
                session,
                full_name=body.fullName,
                email=body.email,
                password_hash=hashed,
                country=body.country,
                country_code=body.countryCode,
                zip_code=body.zipCode,
            )
        except users_repo.EmailTaken as exc:
            # two registrations of the same address raced past the check above
            raise ApiError(409, None, EMAIL_EXISTS) from exc
        out = await self._issue_tokens(session, user, user_agent)
        await session.commit()
        return out

    async def login(
        self, session: AsyncSession, body: LoginBody, user_agent: str | None
    ) -> dict[str, Any]:
        user = await users_repo.find_by_email(session, body.email)
        if user is None or not user.password:
            raise unauthorized(INVALID_CREDENTIALS)
        if not await verify_password_async(body.password, user.password):
            raise unauthorized(INVALID_CREDENTIALS)
        out = await self._issue_tokens(session, user, user_agent)
        await session.commit()
        return out

    async def refresh(
        self, session: AsyncSession, raw_token: str, user_agent: str | None
    ) -> dict[str, Any]:
        user_id, new_raw = await self._refresh.rotate(session, raw_token, user_agent)
        user = await self._user_or_404(session, str(user_id))
        return {
            "accessToken": self.sign_access_token(user),
            "refreshToken": new_raw,
            "user": user_view(user),
        }

    async def logout(self, session: AsyncSession, raw_token: str) -> dict[str, str]:
        await self._refresh.revoke(session, raw_token)
        await session.commit()
        return {"message": LOGGED_OUT}

    async def logout_all(self, session: AsyncSession, user_id: str) -> dict[str, str]:
        await self._refresh.revoke_all_for_user(session, uuid.UUID(user_id))
        await session.commit()
        return {"message": LOGGED_OUT_ALL}

    async def get_profile(self, session: AsyncSession, user_id: str) -> dict[str, Any]:
        return user_view(await self._user_or_404(session, user_id))

    async def _user_or_404(self, session: AsyncSession, user_id: str) -> User:
        user = await users_repo.find_by_id(session, user_id)
        if user is None:
            raise ApiError(404, None, f"User #{user_id} not found")
        return user

    # ─── social ──────────────────────────────────────────────────────────────
    async def google_login(
        self, session: AsyncSession, body: GoogleLoginBody, user_agent: str | None
    ) -> dict[str, Any]:
        identity = await self._google.verify(body.idToken)
        existing = await users_repo.find_by_email(session, identity.email)
        if existing is None and self._is_admin_email(identity.email):
            # the reserved admin address is never created through a social login
            raise ApiError(409, None, EMAIL_EXISTS)
        user = existing or await users_repo.create_social(
            session,
            provider="google",
            provider_user_id=None,
            email=identity.email,
            full_name=identity.full_name,
        )
        if existing is None:
            log.info("Created account from Google sign-in: %s", user.email)
        out = await self._issue_social_tokens(session, user, user_agent)
        await session.commit()
        return out

    async def facebook_login(
        self, session: AsyncSession, body: FacebookLoginBody, user_agent: str | None
    ) -> dict[str, Any]:
        identity = await self._facebook.verify(body.accessToken)
        return await self._social_login(session, identity, user_agent)

    async def apple_login(
        self, session: AsyncSession, body: AppleLoginBody, user_agent: str | None
    ) -> dict[str, Any]:
        identity = await self._apple.verify(body.identityToken, body.fullName)
        return await self._social_login(session, identity, user_agent)

    async def _social_login(
        self, session: AsyncSession, identity: SocialIdentity, user_agent: str | None
    ) -> dict[str, Any]:
        label = "Apple" if identity.provider == "apple" else "Facebook"
        user = await users_repo.find_by_provider(
            session, identity.provider, identity.provider_user_id
        )
        if user is None and identity.email:
            user = await users_repo.find_by_email(session, identity.email)
        if user is None:
            if not identity.email:
                log.warning(
                    "%s sign-in rejected: no email on account %s",
                    label,
                    identity.provider_user_id,
                )
                raise ApiError(
                    422,
                    None,
                    f"Your {label} account has no email address. "
                    "Please sign up with email instead.",
                )
            if self._is_admin_email(identity.email):
                raise ApiError(409, None, EMAIL_EXISTS)
            user = await users_repo.create_social(
                session,
                provider=identity.provider,
                provider_user_id=identity.provider_user_id,
                email=identity.email,
                full_name=identity.full_name,
            )
            log.info("Created account from %s sign-in: %s", label, user.email)
        out = await self._issue_social_tokens(session, user, user_agent)
        await session.commit()
        return out

    # ─── password reset ──────────────────────────────────────────────────────
    async def forgot_password(
        self, session: AsyncSession, email: str
    ) -> dict[str, str]:
        user = await users_repo.find_by_email(session, email)
        if user is not None:
            # Answer first, work later: the response time never reveals whether
            # the address exists (T11).
            task = asyncio.create_task(self._send_reset_link(user.id, user.email))
            self._background.add(task)
            task.add_done_callback(self._background.discard)
        else:
            log.info("Password reset requested for an unregistered email")
        return {"message": FORGOT_PASSWORD_MESSAGE}

    async def _send_reset_link(self, user_id: uuid.UUID, email: str) -> None:
        try:
            raw = secrets.token_hex(32)
            hashed = hash_reset_token(raw)
            minutes = self._settings.RESET_PASSWORD_TOKEN_EXPIRY_MINUTES
            expiry = utcnow() + timedelta(minutes=minutes)
            async with self._sessions() as session:
                await users_repo.set_reset_token(session, user_id, hashed, expiry)
                await session.commit()
            reset_url = (
                f"{self._settings.BACKEND_URL}/{self._settings.API_PREFIX}"
                f"/auth/reset-password?token={raw}"
            )
            try:
                await self._mail.send_password_reset_email(email, reset_url)
            except Exception:
                async with self._sessions() as session:
                    # only this link: a newer one from a concurrent request stays
                    await users_repo.clear_reset_token(session, user_id, hashed)
                    await session.commit()
        except Exception:
            log.exception("Could not issue a password reset for user %s", user_id)

    async def reset_password(
        self, session: AsyncSession, token: str, new_password: str, confirm: str
    ) -> dict[str, str]:
        if new_password != confirm:
            raise ApiError(400, None, "Passwords do not match")
        hashed_token = hash_reset_token(token)
        hashed_password = await hash_password_async(new_password)
        user_id = await users_repo.consume_reset_token(
            session, hashed_token, hashed_password
        )
        if user_id is not None:
            await self._refresh.revoke_all_for_user(session, user_id)
        await session.commit()
        if user_id is None:
            raise ApiError(400, None, "Invalid or expired reset token")
        return {"message": RESET_PASSWORD_MESSAGE}

    async def wait_for_background(self) -> None:
        """Tests: let detached reset work finish."""
        if self._background:
            await asyncio.gather(*list(self._background), return_exceptions=True)
