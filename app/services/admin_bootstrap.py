"""The single ADMIN account, synced from the environment at every boot
(src/auth/admin-bootstrap.service.ts). Env is the source of truth when the
credentials are usable; otherwise nothing changes, so a broken secret can never
lock everyone out.
"""

from __future__ import annotations

import logging
import uuid
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.passwords import hash_password_async, verify_password_async
from app.core.settings import Settings
from app.models.user import User
from app.repositories import users as users_repo
from app.services.refresh_tokens import RefreshTokenService

log = logging.getLogger("app.auth.admin")

ADMIN_BOOTSTRAP_LOCK_KEY = 727302
ADMIN_PASSWORD_MIN_LENGTH = 12

Outcome = Literal[
    "created", "promoted", "updated", "unchanged", "disabled", "skipped", "refused"
]


class AdminBootstrap:
    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        refresh_tokens: RefreshTokenService,
    ) -> None:
        self._settings = settings
        self._sessions = session_factory
        self._refresh = refresh_tokens

    async def run_at_startup(self) -> None:
        try:
            await self.sync()
        except Exception:
            log.exception("Admin bootstrap failed; admin access unchanged")

    async def sync(self) -> Outcome:
        email = (self._settings.ADMIN_EMAIL or "").strip().lower() or None
        password = self._settings.ADMIN_PASSWORD or None
        disabled = self._settings.ADMIN_DISABLE
        usable = (
            bool(email)
            and bool(password)
            and len(password or "") >= ADMIN_PASSWORD_MIN_LENGTH
        )
        if not disabled and not usable:
            log.warning(
                "Admin credentials unusable (ADMIN_EMAIL unset or ADMIN_PASSWORD shorter "
                "than %d chars); existing admin left unchanged. Set ADMIN_DISABLE=true "
                "to remove it.",
                ADMIN_PASSWORD_MIN_LENGTH,
            )
            return "skipped"

        async with self._sessions() as session:
            await users_repo.advisory_xact_lock(session, ADMIN_BOOTSTRAP_LOCK_KEY)
            if disabled:
                demoted = await users_repo.demote_admins_except(session, None)
                await session.commit()
                log.warning(
                    "ADMIN_DISABLE=true; no admin is active%s",
                    f" (demoted {demoted} admin(s))" if demoted else "",
                )
                return "disabled"
            assert email and password  # usable
            existing = await users_repo.find_by_email(session, email)
            if existing is not None and existing.auth_provider != "local":
                await users_repo.demote_admins_except(session, None)
                await session.commit()
                log.error(
                    "ADMIN_EMAIL belongs to a %s account; refusing to promote it. "
                    "No admin is active.",
                    existing.auth_provider,
                )
                return "refused"

            outcome: Outcome
            admin_id: uuid.UUID
            if existing is None:
                user = User(
                    full_name="Admin",
                    email=email,
                    password=await hash_password_async(password),
                    country=None,
                    country_code=None,
                    zip_code=None,
                    auth_provider="local",
                    provider_user_id=None,
                    role="ADMIN",
                )
                session.add(user)
                await session.flush()
                admin_id = user.id
                outcome = "created"
            else:
                admin_id = existing.id
                patch: dict[str, object] = {}
                if existing.role != "ADMIN":
                    patch["role"] = "ADMIN"
                if not existing.password or not await verify_password_async(
                    password, existing.password
                ):
                    patch["password"] = await hash_password_async(password)
                await users_repo.update_fields(session, admin_id, **patch)
                outcome = (
                    "promoted"
                    if "role" in patch
                    else "updated"
                    if "password" in patch
                    else "unchanged"
                )
            demoted = await users_repo.demote_admins_except(session, admin_id)
            await session.commit()
            if outcome != "unchanged" or demoted:
                log.info(
                    "Admin %s: %s%s",
                    outcome,
                    email,
                    f"; demoted {demoted} other admin(s)" if demoted else "",
                )
        if outcome in ("promoted", "updated"):
            async with self._sessions() as session:
                await self._refresh.revoke_all_for_user(session, admin_id)
                await session.commit()
        return outcome
