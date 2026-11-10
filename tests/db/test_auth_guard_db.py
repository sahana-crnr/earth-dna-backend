"""DB-backed guard checks (PY_IT_DB=1): the password-reset cut-off and roles."""

from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator

import jwt
import pytest
from fastapi import APIRouter, Depends
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, insert

from app.core.db import make_engine
from app.core.ratelimit import ThrottledRoute
from app.core.security import JwtPayload, get_current_user, require_roles
from app.main import create_app
from app.models import User
from tests.conftest import TEST_SECRET, make_settings, requires_db

pytestmark = [requires_db, pytest.mark.db]

router = APIRouter(route_class=ThrottledRoute)


@router.get("/me")
async def me(user: JwtPayload = Depends(get_current_user)) -> str:
    return user["sub"]


@router.get("/admin-only")
async def admin_only(user: JwtPayload = Depends(require_roles("ADMIN"))) -> str:
    return "admin"


@pytest.fixture
async def seeded() -> AsyncIterator[dict[str, str]]:
    settings = make_settings()
    engine = make_engine(settings)
    uid, aid = uuid.uuid4(), uuid.uuid4()
    email_u, email_a = f"u-{uid}@test.local", f"a-{aid}@test.local"
    async with engine.begin() as conn:
        await conn.execute(
            insert(User).values(
                [
                    {
                        "id": uid,
                        "fullName": "U",
                        "email": email_u,
                        "country": "US",
                        "role": "USER",
                    },
                    {
                        "id": aid,
                        "fullName": "A",
                        "email": email_a,
                        "country": "US",
                        "role": "ADMIN",
                    },
                ]
            )
        )
    try:
        yield {"user": str(uid), "admin": str(aid)}
    finally:
        async with engine.begin() as conn:
            await conn.execute(delete(User).where(User.id.in_([uid, aid])))
        await engine.dispose()


def _tok(sub: str, iat: int | None = None) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "sub": sub,
            "email": "x@y.z",
            "iat": iat if iat is not None else now,
            "exp": now + 300,
        },
        TEST_SECRET,
        algorithm="HS256",
    )


async def test_guard_and_roles(seeded: dict[str, str]) -> None:
    app = create_app(make_settings())
    app.include_router(router, prefix="/t")
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c,
    ):
        ok = await c.get(
            "/t/me", headers={"Authorization": f"Bearer {_tok(seeded['user'])}"}
        )
        assert ok.status_code == 200 and ok.json()["data"] == seeded["user"]

        unknown = await c.get(
            "/t/me", headers={"Authorization": f"Bearer {_tok(str(uuid.uuid4()))}"}
        )
        # Node let this through (it only looked up passwordChangedAt); the Python
        # guard refuses a token whose account no longer exists. Deliberate.
        assert unknown.status_code == 401

        forbidden = await c.get(
            "/t/admin-only",
            headers={"Authorization": f"Bearer {_tok(seeded['user'])}"},
        )
        assert forbidden.status_code == 403
        assert forbidden.json()["code"] == "FORBIDDEN_ROLE"
        assert (
            forbidden.json()["message"]
            == "You do not have permission to access this resource"
        )

        admin = await c.get(
            "/t/admin-only",
            headers={"Authorization": f"Bearer {_tok(seeded['admin'])}"},
        )
        assert admin.status_code == 200

        # set passwordChangedAt in the future of the token's iat → 401
        from sqlalchemy import update

        from app.core.time import utcnow

        async with app.state.engine.begin() as conn:
            await conn.execute(
                update(User)
                .where(User.id == uuid.UUID(seeded["user"]))
                .values(passwordChangedAt=utcnow())
            )
        stale = await c.get(
            "/t/me",
            headers={
                "Authorization": f"Bearer {_tok(seeded['user'], iat=int(time.time()) - 120)}"
            },
        )
        assert stale.status_code == 401
        assert stale.json()["message"] == "Invalid or expired token"
