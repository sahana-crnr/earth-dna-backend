"""Facebook tokens (src/auth/facebook/facebook-token-verifier.ts).

iOS Limited Login hands the app an OIDC JWT (verified against Facebook's JWKS);
Android hands it a classic access token (verified through Graph `debug_token`
and `me` with an `appsecret_proof`).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from typing import Any, NoReturn

import httpx

from app.core.errors import ApiError, unauthorized
from app.core.settings import Settings
from app.services.social.identity import (
    SocialIdentity,
    looks_like_jwt,
    normalise_email,
    resolve_full_name,
)
from app.services.social.jwks import JwksVerifier

log = logging.getLogger("app.auth.facebook")

FACEBOOK_JWKS_URL = "https://www.facebook.com/.well-known/oauth/openid/jwks/"
FACEBOOK_ISSUER = "https://www.facebook.com"
FACEBOOK_GRAPH_URL = "https://graph.facebook.com"
FACEBOOK_GRAPH_VERSION = "v21.0"
GRAPH_TIMEOUT_S = 5.0
GENERIC_REJECTION = "Invalid Facebook token"


def _error_message(obj: dict[str, Any] | None) -> str | None:
    """`obj.error.message` when present (Graph error envelope)."""
    if not isinstance(obj, dict):
        return None
    err = obj.get("error")
    if isinstance(err, dict):
        msg = err.get("message")
        return msg if isinstance(msg, str) else None
    return None


class FacebookTokenVerifier:
    def __init__(
        self,
        settings: Settings,
        jwks: JwksVerifier,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._settings = settings
        self._jwks = jwks
        self._http = http

    async def verify(self, access_token: str) -> SocialIdentity:
        app_id = self._settings.FACEBOOK_APP_ID
        if not app_id:
            log.error(
                "FACEBOOK_APP_ID is not configured - rejecting all Facebook sign-ins"
            )
            raise unauthorized("Facebook sign-in is not available")
        if looks_like_jwt(access_token):
            return await self._verify_limited_login_jwt(access_token, app_id)
        return await self._verify_classic_token(access_token, app_id)

    async def _verify_limited_login_jwt(
        self, token: str, app_id: str
    ) -> SocialIdentity:
        try:
            payload = await self._jwks.verify(
                token,
                jwks_url=FACEBOOK_JWKS_URL,
                issuer=FACEBOOK_ISSUER,
                audience=app_id,
            )
        except ApiError:
            raise
        except Exception as exc:
            return self._reject(f"jwt: {exc or 'verification failed'}")
        sub_raw = payload.get("sub")
        sub = sub_raw.strip() if isinstance(sub_raw, str) else ""
        if not sub:
            return self._reject("jwt: payload carried no sub")
        email = normalise_email(payload.get("email"))
        name_raw = payload.get("name")
        if isinstance(name_raw, str):
            name = name_raw
        else:
            name = " ".join(
                p
                for p in (payload.get("given_name"), payload.get("family_name"))
                if isinstance(p, str)
            )
        return SocialIdentity(
            provider="facebook",
            provider_user_id=sub,
            email=email,
            full_name=resolve_full_name(name, email),
        )

    async def _verify_classic_token(self, token: str, app_id: str) -> SocialIdentity:
        app_secret = self._settings.FACEBOOK_APP_SECRET
        if not app_secret:
            log.error(
                "FACEBOOK_APP_SECRET is not configured - rejecting classic Facebook tokens"
            )
            raise unauthorized("Facebook sign-in is not available")
        debug = await self._graph_get(
            "/debug_token",
            {"input_token": token, "access_token": f"{app_id}|{app_secret}"},
        )
        data = debug.get("data") if isinstance(debug, dict) else None
        if not debug or debug.get("error") or not isinstance(data, dict):
            msg = _error_message(debug)
            return self._reject(f"debug_token: {msg or 'no data in response'}")
        if data.get("is_valid") is not True:
            reason = _error_message(data) or "no reason"
            return self._reject(f"debug_token: is_valid=false ({reason})")
        if data.get("app_id") != app_id:
            return self._reject(
                f"debug_token: token issued for app {data.get('app_id') or '?'}, not ours"
            )
        expires_at = data.get("expires_at")
        if (
            isinstance(expires_at, int | float)
            and expires_at != 0
            and expires_at * 1000 <= time.time() * 1000
        ):
            return self._reject("debug_token: token expired")
        proof = hmac.new(
            app_secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        me = await self._graph_get(
            f"/{FACEBOOK_GRAPH_VERSION}/me",
            {
                "fields": "id,name,email",
                "access_token": token,
                "appsecret_proof": proof,
            },
        )
        if not me or me.get("error") or not me.get("id"):
            msg = _error_message(me)
            return self._reject(f"me: {msg or 'no id in response'}")
        if data.get("user_id") and me["id"] != data.get("user_id"):
            return self._reject("me: user_id does not match debug_token")
        email = normalise_email(me.get("email"))
        return SocialIdentity(
            provider="facebook",
            provider_user_id=str(me["id"]),
            email=email,
            full_name=resolve_full_name(
                me.get("name") if isinstance(me.get("name"), str) else None, email
            ),
        )

    async def _graph_get(
        self, path: str, params: dict[str, str]
    ) -> dict[str, Any] | None:
        try:
            if self._http is not None:
                r = await self._http.get(FACEBOOK_GRAPH_URL + path, params=params)
            else:
                async with httpx.AsyncClient(timeout=GRAPH_TIMEOUT_S) as client:
                    r = await client.get(FACEBOOK_GRAPH_URL + path, params=params)
            body = r.json()
            return body if isinstance(body, dict) else None
        except Exception as exc:
            log.warning("Graph API %s failed: %s", path, exc)
            return None

    def _reject(self, reason: str) -> NoReturn:
        log.warning("Facebook token rejected: %s", reason)
        raise unauthorized(GENERIC_REJECTION)
