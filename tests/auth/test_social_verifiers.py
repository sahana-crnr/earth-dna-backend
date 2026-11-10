"""Social verifier properties, ported from google-signin.pbt / social-signin.pbt.

RS256 tokens are signed with a local key; `JwksVerifier.signing_key` is swapped
so no network is touched.
"""

from __future__ import annotations

import time
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.core.errors import ApiError
from app.services.social.apple import APPLE_ISSUER, AppleTokenVerifier
from app.services.social.facebook import FacebookTokenVerifier
from app.services.social.google import GOOGLE_ISSUERS, GoogleTokenVerifier
from app.services.social.identity import looks_like_jwt, resolve_full_name
from app.services.social.jwks import JwksVerifier
from tests.conftest import make_settings

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUB = KEY.public_key()


class LocalJwks(JwksVerifier):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def signing_key(self, token: str, jwks_url: str) -> Any:
        self.calls += 1
        return PUB


def sign(payload: dict[str, Any]) -> str:
    base = {"iat": int(time.time()), "exp": int(time.time()) + 300}
    return jwt.encode(
        {**base, **payload}, KEY, algorithm="RS256", headers={"kid": "k1"}
    )


CLIENT_IDS = ["com.earthdna.app", "123-abc.apps.googleusercontent.com"]
emails = st.emails()
names = st.one_of(st.none(), st.text(max_size=20))


# ─── identity helpers ────────────────────────────────────────────────────────
@given(names, st.one_of(st.none(), emails))
def test_resolve_full_name_never_empty(name: str | None, email: str | None) -> None:
    out = resolve_full_name(name, email)
    assert out and out == out.strip()
    if name and name.strip():
        assert out == name.strip()
    elif email:
        assert out == email.split("@")[0].strip()
    else:
        assert out == "Earth DNA User"


@given(st.text(max_size=40))
def test_looks_like_jwt_matches_node_regex(token: str) -> None:
    import re

    parts = token.split(".")
    expected = len(parts) == 3 and all(
        re.fullmatch(r"[A-Za-z0-9_-]+", p) for p in parts
    )
    assert looks_like_jwt(token) is expected


# ─── Google ──────────────────────────────────────────────────────────────────
@settings(max_examples=60, suppress_health_check=[HealthCheck.too_slow], deadline=None)
@given(
    emails,
    st.sampled_from(CLIENT_IDS),
    st.sampled_from(GOOGLE_ISSUERS),
    st.one_of(st.none(), st.just(False), st.just("true"), st.just(0)),
)
async def test_google_p1_unverified_email_never_accepted(
    email: str, aud: str, iss: str, verified: object
) -> None:
    v = GoogleTokenVerifier(make_settings(GOOGLE_CLIENT_IDS=CLIENT_IDS), LocalJwks())
    payload: dict[str, Any] = {"iss": iss, "aud": aud, "sub": "1", "email": email}
    if verified is not None:
        payload["email_verified"] = verified
    with pytest.raises(ApiError) as exc:
        await v.verify(sign(payload))
    assert exc.value.status == 401
    assert exc.value.message == "Google account email is not verified"


@settings(max_examples=60, deadline=None)
@given(emails, st.text(min_size=1, max_size=30).filter(lambda a: a not in CLIENT_IDS))
async def test_google_p2_wrong_audience_rejected(email: str, aud: str) -> None:
    v = GoogleTokenVerifier(make_settings(GOOGLE_CLIENT_IDS=CLIENT_IDS), LocalJwks())
    tok = sign(
        {
            "iss": GOOGLE_ISSUERS[1],
            "aud": aud,
            "sub": "1",
            "email": email,
            "email_verified": True,
        }
    )
    with pytest.raises(ApiError) as exc:
        await v.verify(tok)
    assert exc.value.message == "Invalid Google token"


async def test_google_p2b_empty_client_ids_rejects_without_jwks() -> None:
    jwks = LocalJwks()
    v = GoogleTokenVerifier(make_settings(GOOGLE_CLIENT_IDS=[]), jwks)
    tok = sign(
        {
            "iss": GOOGLE_ISSUERS[0],
            "aud": CLIENT_IDS[0],
            "sub": "1",
            "email": "a@b.co",
            "email_verified": True,
        }
    )
    with pytest.raises(ApiError) as exc:
        await v.verify(tok)
    assert exc.value.message == "Google sign-in is not available"
    assert jwks.calls == 0


@settings(max_examples=60, deadline=None)
@given(emails, names, st.sampled_from(CLIENT_IDS), st.sampled_from(GOOGLE_ISSUERS))
async def test_google_accepts_valid_and_names_non_empty(
    email: str, name: str | None, aud: str, iss: str
) -> None:
    v = GoogleTokenVerifier(make_settings(GOOGLE_CLIENT_IDS=CLIENT_IDS), LocalJwks())
    payload: dict[str, Any] = {
        "iss": iss,
        "aud": aud,
        "sub": "1",
        "email": email,
        "email_verified": True,
    }
    if name is not None:
        payload["name"] = name
    out = await v.verify(sign(payload))
    assert out.email == email and out.email_verified is True
    assert out.full_name == ((name or "").strip() or email.split("@")[0])


async def test_google_bad_signature_and_expired() -> None:
    v = GoogleTokenVerifier(make_settings(GOOGLE_CLIENT_IDS=CLIENT_IDS), LocalJwks())
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = jwt.encode(
        {
            "iss": GOOGLE_ISSUERS[0],
            "aud": CLIENT_IDS[0],
            "sub": "1",
            "email": "a@b.co",
            "email_verified": True,
            "exp": int(time.time()) + 60,
        },
        other,
        algorithm="RS256",
    )
    expired = sign(
        {
            "iss": GOOGLE_ISSUERS[0],
            "aud": CLIENT_IDS[0],
            "sub": "1",
            "email": "a@b.co",
            "email_verified": True,
            "exp": int(time.time()) - 10,
        }
    )
    for tok in (forged, expired, "x.y.z"):
        with pytest.raises(ApiError) as exc:
            await v.verify(tok)
        assert exc.value.message == "Invalid Google token"


# ─── Apple ───────────────────────────────────────────────────────────────────
@settings(max_examples=60, deadline=None)
@given(st.text(min_size=1, max_size=30).filter(lambda a: a not in CLIENT_IDS))
async def test_apple_p5_wrong_audience(aud: str) -> None:
    v = AppleTokenVerifier(make_settings(APPLE_CLIENT_IDS=CLIENT_IDS), LocalJwks())
    with pytest.raises(ApiError) as exc:
        await v.verify(sign({"iss": APPLE_ISSUER, "aud": aud, "sub": "apple-1"}))
    assert exc.value.message == "Invalid Apple token"


async def test_apple_p5b_empty_audience_no_jwks() -> None:
    jwks = LocalJwks()
    v = AppleTokenVerifier(make_settings(APPLE_CLIENT_IDS=[]), jwks)
    with pytest.raises(ApiError) as exc:
        await v.verify(
            sign({"iss": APPLE_ISSUER, "aud": CLIENT_IDS[0], "sub": "apple-1"})
        )
    assert exc.value.message == "Apple sign-in is not available" and jwks.calls == 0


@settings(max_examples=60, deadline=None)
@given(
    st.text(min_size=1, max_size=20).map(str.strip).filter(bool),
    st.one_of(st.none(), emails),
    names,
)
async def test_apple_accepts_and_keys_on_sub(
    sub: str, email: str | None, hint: str | None
) -> None:
    v = AppleTokenVerifier(make_settings(APPLE_CLIENT_IDS=CLIENT_IDS), LocalJwks())
    payload: dict[str, Any] = {"iss": APPLE_ISSUER, "aud": CLIENT_IDS[0], "sub": sub}
    if email is not None:
        payload["email"] = email.upper()
    out = await v.verify(sign(payload), hint)
    assert out.provider == "apple" and out.provider_user_id == sub
    assert out.email == (email.lower() if email else None)
    assert out.full_name == resolve_full_name(hint, out.email)


@pytest.mark.parametrize("flag", [False, "false"])
async def test_apple_unverified_email_rejected(flag: object) -> None:
    v = AppleTokenVerifier(make_settings(APPLE_CLIENT_IDS=CLIENT_IDS), LocalJwks())
    with pytest.raises(ApiError) as exc:
        await v.verify(
            sign(
                {
                    "iss": APPLE_ISSUER,
                    "aud": CLIENT_IDS[0],
                    "sub": "s",
                    "email": "a@b.co",
                    "email_verified": flag,
                }
            )
        )
    assert exc.value.message == "Apple account email is not verified"


# ─── Facebook ────────────────────────────────────────────────────────────────
def _graph(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_facebook_p3_jwt_goes_to_jwks_opaque_goes_to_graph() -> None:
    jwks = LocalJwks()
    graph_calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        graph_calls.append(req.url.path)
        if req.url.path == "/debug_token":
            return httpx.Response(
                200,
                json={
                    "data": {
                        "app_id": "app1",
                        "is_valid": True,
                        "user_id": "u9",
                        "expires_at": 0,
                    }
                },
            )
        return httpx.Response(
            200, json={"id": "u9", "name": "Fb User", "email": "FB@Example.com"}
        )

    v = FacebookTokenVerifier(
        make_settings(FACEBOOK_APP_ID="app1", FACEBOOK_APP_SECRET="sec"),
        jwks,
        http=_graph(handler),
    )
    jwt_tok = sign(
        {
            "iss": "https://www.facebook.com",
            "aud": "app1",
            "sub": "fb-sub",
            "email": "J@X.io",
            "name": "Jane",
        }
    )
    out = await v.verify(jwt_tok)
    assert (
        out.provider_user_id == "fb-sub"
        and out.email == "j@x.io"
        and out.full_name == "Jane"
    )
    assert jwks.calls == 1 and graph_calls == []

    out2 = await v.verify("EAAPopaque123")
    assert (
        out2.provider_user_id == "u9"
        and out2.email == "fb@example.com"
        and out2.full_name == "Fb User"
    )
    assert graph_calls == ["/debug_token", "/v21.0/me"] and jwks.calls == 1


@pytest.mark.parametrize(
    "debug",
    [
        {"error": {"message": "bad"}},
        {"data": {"is_valid": False, "error": {"message": "expired"}}},
        {"data": {"is_valid": True, "app_id": "other"}},
        {"data": {"is_valid": True, "app_id": "app1", "expires_at": 1}},
    ],
)
async def test_facebook_classic_rejections(debug: dict[str, Any]) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json=debug if req.url.path == "/debug_token" else {"id": "u"}
        )

    v = FacebookTokenVerifier(
        make_settings(FACEBOOK_APP_ID="app1", FACEBOOK_APP_SECRET="sec"),
        LocalJwks(),
        http=_graph(handler),
    )
    with pytest.raises(ApiError) as exc:
        await v.verify("opaque")
    assert exc.value.message == "Invalid Facebook token"


async def test_facebook_not_configured() -> None:
    v = FacebookTokenVerifier(make_settings(FACEBOOK_APP_ID=""), LocalJwks())
    with pytest.raises(ApiError) as exc:
        await v.verify("x")
    assert exc.value.message == "Facebook sign-in is not available"
