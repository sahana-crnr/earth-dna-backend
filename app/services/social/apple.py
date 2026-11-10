"""Sign in with Apple identity tokens (src/auth/apple/apple-token-verifier.ts)."""

from __future__ import annotations

import logging
from typing import NoReturn

from app.core.errors import ApiError, unauthorized
from app.core.settings import Settings
from app.services.social.identity import SocialIdentity, resolve_full_name
from app.services.social.jwks import JwksVerifier

log = logging.getLogger("app.auth.apple")

APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
APPLE_ISSUER = "https://appleid.apple.com"
GENERIC_REJECTION = "Invalid Apple token"


class AppleTokenVerifier:
    def __init__(self, settings: Settings, jwks: JwksVerifier) -> None:
        self._settings = settings
        self._jwks = jwks

    async def verify(
        self, identity_token: str, full_name_hint: str | None = None
    ) -> SocialIdentity:
        client_ids = self._settings.APPLE_CLIENT_IDS
        if not client_ids:
            log.error(
                "APPLE_CLIENT_IDS is not configured - rejecting all Apple sign-ins"
            )
            raise unauthorized("Apple sign-in is not available")
        try:
            payload = await self._jwks.verify(
                identity_token,
                jwks_url=APPLE_JWKS_URL,
                issuer=APPLE_ISSUER,
                audience=client_ids,
            )
        except ApiError:
            raise
        except Exception as exc:
            return self._reject(str(exc) or "verification failed")
        sub_raw = payload.get("sub")
        sub = sub_raw.strip() if isinstance(sub_raw, str) else ""
        if not sub:
            return self._reject("payload carried no sub")
        email_raw = payload.get("email")
        email = (
            email_raw.strip().lower()
            if isinstance(email_raw, str) and email_raw.strip()
            else None
        )
        verified = payload.get("email_verified")
        if verified is False or verified == "false":
            log.warning("Apple token rejected for sub %s: email not verified", sub)
            raise unauthorized("Apple account email is not verified")
        return SocialIdentity(
            provider="apple",
            provider_user_id=sub,
            email=email,
            full_name=resolve_full_name(full_name_hint, email),
        )

    def _reject(self, reason: str) -> NoReturn:
        log.warning("Apple token rejected: %s", reason)
        raise unauthorized(GENERIC_REJECTION)
