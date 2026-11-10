"""RS256 ID-token verification against a provider's JWKS (src/auth/social/jwks-jwt-verifier.ts)."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

import jwt
from jwt import PyJWKClient

JWKS_FETCH_TIMEOUT_S = 5


class JwksVerifier:
    """One cached key set per JWKS URL; verification happens off the event loop."""

    def __init__(self) -> None:
        self._clients: dict[str, PyJWKClient] = {}

    def _client(self, url: str) -> PyJWKClient:
        c = self._clients.get(url)
        if c is None:
            c = PyJWKClient(url, cache_keys=True, timeout=JWKS_FETCH_TIMEOUT_S)
            self._clients[url] = c
        return c

    def signing_key(self, token: str, jwks_url: str) -> Any:
        """Separated so tests can swap in a local key."""
        return self._client(jwks_url).get_signing_key_from_jwt(token).key

    def _verify_sync(
        self,
        token: str,
        jwks_url: str,
        issuer: str | Sequence[str],
        audience: str | Sequence[str],
    ) -> dict[str, Any]:
        key = self.signing_key(token, jwks_url)
        issuers = [issuer] if isinstance(issuer, str) else list(issuer)
        payload: dict[str, Any] = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=list(audience) if not isinstance(audience, str) else audience,
            options={"verify_iss": False, "require": ["exp", "iss"]},
        )
        if payload.get("iss") not in issuers:
            raise jwt.InvalidIssuerError("Invalid issuer")
        return payload

    async def verify(
        self,
        token: str,
        *,
        jwks_url: str,
        issuer: str | Sequence[str],
        audience: str | Sequence[str],
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._verify_sync, token, jwks_url, issuer, audience
        )
