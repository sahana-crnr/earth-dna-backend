"""End-to-end auth flows against the local database (PY_IT_DB=1).

Ports the Node AuthService / password-reset.it / social-signin DB cases:
register → login → refresh rotation and theft detection → logout, profile,
forgot/reset with the real token path, admin bootstrap outcomes, social
sign-in linking and the admin refusal.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select, update

from app.core.time import utcnow
from app.main import create_app
from app.models import RefreshToken, User
from app.services.social.identity import SocialIdentity
from tests.conftest import make_settings, requires_db

pytestmark = [requires_db, pytest.mark.db]

RUN = uuid.uuid4().hex[:8]


def email(tag: str) -> str:
    return f"{tag}-{RUN}@pyflow.test"


@pytest.fixture
async def app_client(
    request: pytest.FixtureRequest,
) -> AsyncIterator[tuple[Any, AsyncClient]]:
    overrides = getattr(request, "param", {})
    settings = make_settings(MAIL_DRY_RUN=True, **overrides)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://t"
        ) as c:
            yield app, c
        async with app.state.engine.begin() as conn:
            await conn.execute(
                delete(User).where(User.email.like(f"%-{RUN}@pyflow.test"))
            )


REG = {
    "fullName": "Flow User",
    "email": email("reg"),
    "password": "Passw0rd!xyz",
    "country": "US",
}


async def test_register_login_refresh_logout_profile(
    app_client: tuple[Any, AsyncClient],
) -> None:
    app, c = app_client
    r = await c.post("/api/v1/auth/register", json=REG)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["statusCode"] == 201 and set(body["data"]) == {
        "accessToken",
        "refreshToken",
        "user",
    }
    user = body["data"]["user"]
    assert set(user) == {
        "id",
        "fullName",
        "email",
        "country",
        "countryCode",
        "zipCode",
        "role",
        "createdAt",
        "updatedAt",
    }
    assert user["email"] == REG["email"].lower() and user["role"] == "USER"
    assert user["createdAt"].endswith("Z")
    access, refresh = body["data"]["accessToken"], body["data"]["refreshToken"]

    dup = await c.post("/api/v1/auth/register", json=REG)
    assert (
        dup.status_code == 409
        and dup.json()["message"] == "An account with this email already exists"
    )

    mixed = await c.post(
        "/api/v1/auth/register", json={**REG, "email": REG["email"].upper()}
    )
    assert mixed.status_code == 409

    wrong = await c.post(
        "/api/v1/auth/login", json={"email": REG["email"], "password": "nope-nope"}
    )
    assert (
        wrong.status_code == 401
        and wrong.json()["message"] == "Invalid email or password"
    )

    ok = await c.post(
        "/api/v1/auth/login",
        json={"email": "  " + REG["email"].upper() + " ", "password": REG["password"]},
    )
    assert ok.status_code == 200 and ok.json()["data"]["user"]["id"] == user["id"]

    prof = await c.get(
        "/api/v1/auth/profile", headers={"Authorization": f"Bearer {access}"}
    )
    assert prof.status_code == 200 and prof.json()["data"] == user

    rot = await c.post("/api/v1/auth/refresh", json={"refreshToken": refresh})
    assert rot.status_code == 200
    new_refresh = rot.json()["data"]["refreshToken"]
    assert new_refresh != refresh and rot.json()["data"]["user"]["id"] == user["id"]

    reuse = await c.post("/api/v1/auth/refresh", json={"refreshToken": refresh})
    assert (
        reuse.status_code == 401 and reuse.json()["message"] == "Invalid refresh token"
    )
    # theft detection ended every session, including the freshly rotated one
    after = await c.post("/api/v1/auth/refresh", json={"refreshToken": new_refresh})
    assert after.status_code == 401

    login2 = await c.post(
        "/api/v1/auth/login", json={"email": REG["email"], "password": REG["password"]}
    )
    rt2 = login2.json()["data"]["refreshToken"]
    out = await c.post("/api/v1/auth/logout", json={"refreshToken": rt2})
    assert out.json()["data"] == {"message": "Logged out successfully."}
    assert (
        await c.post("/api/v1/auth/refresh", json={"refreshToken": rt2})
    ).status_code == 401
    again = await c.post("/api/v1/auth/logout", json={"refreshToken": "garbage"})
    assert again.status_code == 200

    all_out = await c.post(
        "/api/v1/auth/logout-all", headers={"Authorization": f"Bearer {access}"}
    )
    assert all_out.json()["data"] == {
        "message": "Logged out of all sessions successfully."
    }

    garbage = await c.post("/api/v1/auth/refresh", json={"refreshToken": "nope"})
    assert (
        garbage.status_code == 401
        and garbage.json()["message"] == "Invalid refresh token"
    )


async def test_expired_refresh_token_message(
    app_client: tuple[Any, AsyncClient],
) -> None:
    app, c = app_client
    r = await c.post("/api/v1/auth/register", json={**REG, "email": email("exp")})
    rt = r.json()["data"]["refreshToken"]
    async with app.state.engine.begin() as conn:
        await conn.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == hashlib.sha256(rt.encode()).hexdigest())
            .values(expiresAt=utcnow() - timedelta(seconds=1))
        )
    e = await c.post("/api/v1/auth/refresh", json={"refreshToken": rt})
    assert e.status_code == 401 and e.json()["message"] == "Refresh token expired"


async def test_forgot_and_reset_flow(app_client: tuple[Any, AsyncClient]) -> None:
    app, c = app_client
    e = email("reset")
    r = await c.post("/api/v1/auth/register", json={**REG, "email": e})
    rt = r.json()["data"]["refreshToken"]
    access = r.json()["data"]["accessToken"]

    unknown = await c.post(
        "/api/v1/auth/forgot-password", json={"email": "nobody-" + e}
    )
    known = await c.post("/api/v1/auth/forgot-password", json={"email": e.upper()})
    assert unknown.status_code == known.status_code == 200
    assert unknown.json()["data"] == known.json()["data"]
    await app.state.auth.wait_for_background()

    async with app.state.engine.connect() as conn:
        row = (
            await conn.execute(
                select(User.reset_password_token, User.reset_password_expiry).where(
                    User.email == e
                )
            )
        ).one()
    hashed, expiry = row
    assert hashed and expiry > utcnow()

    # The raw token only ever went to the (dry-run) mail; plant a known one.
    raw = "known-raw-token"
    async with app.state.engine.begin() as conn:
        await conn.execute(
            update(User)
            .where(User.email == e)
            .values(resetPasswordToken=hashlib.sha256(raw.encode()).hexdigest())
        )
    mism = await c.post(
        "/api/v1/auth/reset-password",
        json={
            "token": raw,
            "newPassword": "NewPassw0rd",
            "confirmPassword": "NewPassw0rd2",
        },
    )
    assert (
        mism.status_code == 400 and mism.json()["message"] == "Passwords do not match"
    )

    ok = await c.post(
        "/api/v1/auth/reset-password",
        json={
            "token": raw,
            "newPassword": "NewPassw0rd",
            "confirmPassword": "NewPassw0rd",
        },
    )
    assert ok.status_code == 200
    assert ok.json()["data"]["message"].startswith(
        "Your password has been reset successfully"
    )

    used = await c.post(
        "/api/v1/auth/reset-password",
        json={
            "token": raw,
            "newPassword": "NewPassw0rd",
            "confirmPassword": "NewPassw0rd",
        },
    )
    assert (
        used.status_code == 400
        and used.json()["message"] == "Invalid or expired reset token"
    )

    # old refresh token revoked; an access token issued before passwordChangedAt
    # is dead. iat has second precision (same-second tokens are accepted, as in
    # Node), so sign one clearly in the past instead of racing the clock.
    assert (
        await c.post("/api/v1/auth/refresh", json={"refreshToken": rt})
    ).status_code == 401
    import time as _time

    import jwt as _jwt

    from tests.conftest import TEST_SECRET

    uid = r.json()["data"]["user"]["id"]
    old_access = _jwt.encode(
        {
            "sub": uid,
            "email": e,
            "iat": int(_time.time()) - 120,
            "exp": int(_time.time()) + 300,
        },
        TEST_SECRET,
        algorithm="HS256",
    )
    stale = await c.get(
        "/api/v1/auth/profile", headers={"Authorization": f"Bearer {old_access}"}
    )
    assert (
        stale.status_code == 401
        and stale.json()["message"] == "Invalid or expired token"
    )
    assert access  # register-time token: same second as the reset, still accepted

    assert (
        await c.post(
            "/api/v1/auth/login", json={"email": e, "password": REG["password"]}
        )
    ).status_code == 401
    new = await c.post(
        "/api/v1/auth/login", json={"email": e, "password": "NewPassw0rd"}
    )
    assert new.status_code == 200

    form = await c.get("/api/v1/auth/reset-password", params={"token": 'a<b"c'})
    assert (
        form.status_code == 200
        and form.headers["content-type"] == "text/html; charset=utf-8"
    )
    assert 'id="token" value="a&lt;b&quot;c"' in form.text


async def test_social_login_links_and_refuses_admin(
    app_client: tuple[Any, AsyncClient],
) -> None:
    app, c = app_client
    auth = app.state.auth
    e = email("social")

    class FakeApple:
        def __init__(self, identity: SocialIdentity) -> None:
            self.identity = identity

        async def verify(self, token: str, hint: str | None = None) -> SocialIdentity:
            return self.identity

    # brand-new identity without e-mail → 422
    auth._apple = FakeApple(SocialIdentity("apple", "sub-noemail", None, "No Mail"))
    r = await c.post("/api/v1/auth/apple", json={"identityToken": "t.t.t"})
    assert r.status_code == 422
    assert (
        r.json()["message"]
        == "Your Apple account has no email address. Please sign up with email instead."
    )

    # new identity with e-mail → account created, keyed on sub
    auth._apple = FakeApple(SocialIdentity("apple", "sub-1", e, "Apple One"))
    first = await c.post("/api/v1/auth/apple", json={"identityToken": "t.t.t"})
    assert first.status_code == 200 and first.json()["data"]["user"]["email"] == e
    uid = first.json()["data"]["user"]["id"]
    # same identity again, even without e-mail now → same user, one row
    auth._apple = FakeApple(SocialIdentity("apple", "sub-1", None, "Whatever"))
    second = await c.post("/api/v1/auth/apple", json={"identityToken": "t.t.t"})
    assert second.json()["data"]["user"]["id"] == uid
    async with app.state.engine.connect() as conn:
        n = (await conn.execute(select(User.id).where(User.email == e))).all()
    assert len(n) == 1

    # existing password account with the same e-mail is reused, untouched
    pw_email = email("pw")
    reg = await c.post("/api/v1/auth/register", json={**REG, "email": pw_email})
    auth._apple = FakeApple(SocialIdentity("apple", "sub-2", pw_email, "Apple Two"))
    linked = await c.post("/api/v1/auth/apple", json={"identityToken": "t.t.t"})
    assert linked.json()["data"]["user"]["id"] == reg.json()["data"]["user"]["id"]
    assert linked.json()["data"]["user"]["fullName"] == "Flow User"

    # the admin account can never be entered through a social door
    async with app.state.engine.begin() as conn:
        await conn.execute(
            update(User).where(User.email == pw_email).values(role="ADMIN")
        )
    forbidden = await c.post("/api/v1/auth/apple", json={"identityToken": "t.t.t"})
    assert (
        forbidden.status_code == 403
        and forbidden.json()["code"] == "ADMIN_PASSWORD_LOGIN_ONLY"
    )
    # but the password door still works
    assert (
        await c.post(
            "/api/v1/auth/login", json={"email": pw_email, "password": REG["password"]}
        )
    ).status_code == 200


@pytest.mark.parametrize(
    "app_client",
    [{"ADMIN_EMAIL": email("admin").upper(), "ADMIN_PASSWORD": "AdminPassw0rd!123"}],
    indirect=True,
)
async def test_admin_bootstrap_outcomes(app_client: tuple[Any, AsyncClient]) -> None:
    app, c = app_client
    boot = app.state.admin_bootstrap
    e = email("admin")
    # lifespan already ran once → created
    async with app.state.engine.connect() as conn:
        row = (
            await conn.execute(select(User.role, User.full_name).where(User.email == e))
        ).one()
    assert row == ("ADMIN", "Admin")
    assert await boot.sync() == "unchanged"

    # registering the admin address is refused
    r = await c.post("/api/v1/auth/register", json={**REG, "email": e})
    assert r.status_code == 409

    login = await c.post(
        "/api/v1/auth/login", json={"email": e, "password": "AdminPassw0rd!123"}
    )
    assert login.status_code == 200 and login.json()["data"]["user"]["role"] == "ADMIN"

    boot._settings = make_settings(ADMIN_EMAIL=e, ADMIN_PASSWORD="AnotherPassw0rd!456")
    assert await boot.sync() == "updated"
    assert (
        await c.post(
            "/api/v1/auth/refresh",
            json={"refreshToken": login.json()["data"]["refreshToken"]},
        )
    ).status_code == 401

    boot._settings = make_settings(ADMIN_EMAIL=e, ADMIN_PASSWORD="short")
    assert await boot.sync() == "skipped"

    boot._settings = make_settings(ADMIN_DISABLE=True)
    assert await boot.sync() == "disabled"
    async with app.state.engine.connect() as conn:
        role = (
            await conn.execute(select(User.role).where(User.email == e))
        ).scalar_one()
    assert role == "USER"

    # a social account at ADMIN_EMAIL is refused
    async with app.state.engine.begin() as conn:
        await conn.execute(
            update(User).where(User.email == e).values(authProvider="google")
        )
    boot._settings = make_settings(ADMIN_EMAIL=e, ADMIN_PASSWORD="AnotherPassw0rd!456")
    assert await boot.sync() == "refused"
