"""Google ID tokens (src/auth/google/google-token-verifier.ts).

Same checks as google-auth-library's `verifyIdToken`: RS256 signature from
Google's certs, `aud` in the configured client ids, `iss` one of the two
Google issuers, `exp` in the future; then the e-mail must be present and
verified. Every rejection is the same generic 401.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import NoReturn

from app.core.errors import ApiError, unauthorized
from app.core.settings import Settings
from app.services.social.jwks import JwksVerifier

log = logging.getLogger("app.auth.google")

GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")
GENERIC_REJECTION = "Invalid Google token"


@dataclass(frozen=True)
class GoogleIdentity:
    email: str
    full_name: str
    email_verified: bool


class GoogleTokenVerifier:
    def __init__(self, settings: Settings, jwks: JwksVerifier) -> None:
        self._settings = settings
        self._jwks = jwks

    async def verify(self, id_token: str) -> GoogleIdentity:
        client_ids = self._settings.GOOGLE_CLIENT_IDS
        if not client_ids:
            log.error(
                "GOOGLE_CLIENT_IDS is not configured - rejecting all Google sign-ins"
            )
            raise unauthorized("Google sign-in is not available")
        try:
            payload = await self._jwks.verify(
                id_token,
                jwks_url=GOOGLE_JWKS_URL,
                issuer=GOOGLE_ISSUERS,
                audience=client_ids,
            )
        except ApiError:
            raise
        except Exception as exc:
            self._reject(str(exc) or "verification failed")
        if not payload:
            self._reject("token carried no payload")
        if payload.get("iss") not in GOOGLE_ISSUERS:
            self._reject(f"unexpected issuer: {payload.get('iss')}")
        email = payload.get("email")
        if not isinstance(email, str) or not email:
            self._reject("payload carried no email")
        if payload.get("email_verified") is not True:
            log.warning("Google token rejected for %s: email not verified", email)
            raise unauthorized("Google account email is not verified")
        name = payload.get("name")
        full_name = (
            name.strip()
            if isinstance(name, str) and name.strip()
            else email.split("@")[0]
        )
        return GoogleIdentity(email=email, full_name=full_name, email_verified=True)

    def _reject(self, reason: str) -> NoReturn:
        log.warning("Google token rejected: %s", reason)
        raise unauthorized(GENERIC_REJECTION)
