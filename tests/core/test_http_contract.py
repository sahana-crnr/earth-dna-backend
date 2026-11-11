"""P5 and the error envelope, against the Node goldens captured on 2026-11-10."""

from __future__ import annotations

import re
from typing import Any

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from hypothesis import given, settings
from hypothesis import strategies as st

from app.core.envelope import EnvelopedJSONResponse
from app.core.errors import ApiError, install_exception_handlers
from app.core.ratelimit import ThrottledRoute, throttle
from app.main import create_app
from tests.conftest import make_settings

TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def _app() -> TestClient:
    return TestClient(create_app(make_settings()), raise_server_exceptions=False)


def test_health_matches_node_golden() -> None:
    with _app() as c:
        r = c.get("/api/v1")
    assert r.status_code == 200
    body = r.json()
    assert body["statusCode"] == 200
    assert body["message"] == "Success"
    assert body["data"] == "Welcome to the Earth DNA API!"
    assert TS.match(body["timestamp"])
    assert set(body) == {"statusCode", "message", "data", "timestamp"}
    assert r.headers["X-RateLimit-Limit"] == "100"
    assert r.headers["X-RateLimit-Remaining"] == "99"
    assert r.headers["X-RateLimit-Reset"] == "60"
    assert r.headers["Access-Control-Allow-Origin"] == "*"
    assert "X-Powered-By" not in r.headers


def test_unknown_route_is_404_cannot_get() -> None:
    with _app() as c:
        r = c.get("/api/v1/nope")
        d = c.delete("/api/v1")
    assert r.status_code == 404
    assert r.json() == {
        "statusCode": 404,
        "timestamp": r.json()["timestamp"],
        "path": "/api/v1/nope",
        "message": "Cannot GET /api/v1/nope",
    }
    assert d.status_code == 404
    assert d.json()["message"] == "Cannot DELETE /api/v1"


def test_error_path_keeps_query_string() -> None:
    with _app() as c:
        r = c.get("/api/v1/catalog/colours?brandId=nope")
    assert r.json()["path"] == "/api/v1/catalog/colours?brandId=nope"


def test_cors_preflight_like_node() -> None:
    with _app() as c:
        r = c.options(
            "/api/v1/auth/login",
            headers={
                "Origin": "http://x.test",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Authorization, X-Custom",
            },
        )
    assert r.headers["access-control-allow-origin"] == "*"
    assert "POST" in r.headers["access-control-allow-methods"]
    # Express cors() reflects whatever headers the browser asks for
    allowed = r.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed and "x-custom" in allowed


def _mini_app() -> FastAPI:
    app = FastAPI(default_response_class=EnvelopedJSONResponse)
    app.state.settings = make_settings(THROTTLE_LIMIT=3)
    install_exception_handlers(app)
    r = APIRouter(route_class=ThrottledRoute)

    @r.get("/echo")
    async def echo(v: str = "") -> dict[str, str]:
        return {"v": v}

    @r.post("/created", status_code=201)
    async def created() -> list[int]:
        return [1, 2]

    @r.get("/api-error")
    async def api_error() -> None:
        raise ApiError(409, "SOME_CODE", "Conflict here", {"id": "x"})

    @r.get("/boom")
    async def boom() -> None:
        raise RuntimeError("secret stack")

    @r.get("/tight")
    @throttle(1, 60000)
    async def tight() -> str:
        return "ok"

    app.include_router(r)
    return app


def test_post_default_201_and_api_error_shape() -> None:
    with TestClient(_mini_app(), raise_server_exceptions=False) as c:
        p = c.post("/created")
        e = c.get("/api-error")
        b = c.get("/boom")
    assert (
        p.status_code == 201
        and p.json()["statusCode"] == 201
        and p.json()["data"] == [1, 2]
    )
    assert e.status_code == 409
    assert e.json() == {
        "statusCode": 409,
        "timestamp": e.json()["timestamp"],
        "path": "/api-error",
        "message": "Conflict here",
        "code": "SOME_CODE",
        "details": {"id": "x"},
    }
    assert b.status_code == 500
    assert b.json()["message"] == "Internal server error"
    assert "secret" not in b.text


def test_throttle_override_and_429_golden() -> None:
    with TestClient(_mini_app(), raise_server_exceptions=False) as c:
        first = c.get("/tight")
        second = c.get("/tight")
        other = c.get("/echo")
    assert first.status_code == 200
    assert second.status_code == 429
    assert second.json()["message"] == "ThrottlerException: Too Many Requests"
    assert second.headers["Retry-After"] == "60"
    assert "X-RateLimit-Limit" not in second.headers
    assert other.status_code == 200  # per route key


@settings(max_examples=150)
@given(
    st.recursive(
        st.one_of(st.none(), st.booleans(), st.integers(), st.text(max_size=8)),
        lambda s: st.lists(s, max_size=4)
        | st.dictionaries(st.text(max_size=5), s, max_size=4),
        max_leaves=10,
    ),
    st.sampled_from([200, 201, 202]),
)
def test_envelope_roundtrips_data(data: Any, status: int) -> None:
    import json

    resp = EnvelopedJSONResponse(content=data, status_code=status)
    body = json.loads(resp.body)
    assert body["data"] == data
    assert body["statusCode"] == status
    assert body["message"] == "Success"
    assert TS.match(body["timestamp"])


@pytest.mark.parametrize("header", [None, "Basic abc", "Bearer", "bearer x", "Token x"])
def test_missing_token_strings(header: str | None) -> None:
    from app.core.security import bearer_token

    assert bearer_token(header) is None
    assert bearer_token("Bearer abc.def.ghi") == "abc.def.ghi"
