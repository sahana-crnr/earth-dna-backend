"""Regression tests for the pre-commit review findings (U6)."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.core.errors import ApiError, install_exception_handlers
from app.core.ratelimit import RateLimiter
from app.core.validation import read_json_body
from app.schemas.scan import parse_manifest
from tests.conftest import make_settings


def test_database_url_escapes_special_characters() -> None:
    s = make_settings(DB_PASSWORD="p@ss/w:rd#x", DB_HOST="db.example", DB_NAME="earth")
    url = s.database_url
    assert url.endswith("@db.example:5433/earth") or url.endswith(
        "@db.example:5432/earth"
    )
    assert "p@ss/w:rd#x" not in url  # escaped, not raw
    assert "%40" in url and "%2F" in url


def test_log_level_validated() -> None:
    assert make_settings(LOG_LEVEL="debug").LOG_LEVEL == "DEBUG"
    with pytest.raises(ValueError):
        make_settings(LOG_LEVEL="VERBOSE")


def test_manifest_rejects_non_object_items() -> None:
    with pytest.raises(ApiError) as exc:
        parse_manifest(json.dumps({"shoes": [1]}))
    assert exc.value.status == 400
    with pytest.raises(ApiError) as exc2:
        parse_manifest(json.dumps({"shoes": [{"ref": "a", "files": [None]}]}))
    assert exc2.value.status == 400


def _body_app() -> FastAPI:
    app = FastAPI()
    install_exception_handlers(app)

    @app.post("/echo")
    async def echo(request: Request) -> dict[str, object]:
        return await read_json_body(request)

    return app


@pytest.mark.parametrize("raw", [b'{"a": NaN}', b'{"a": Infinity}', b'{"a": "\xff"}'])
def test_strict_json_body_is_400(raw: bytes) -> None:
    client = TestClient(_body_app(), raise_server_exceptions=False)
    r = client.post("/echo", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 400, r.text
    assert r.json()["statusCode"] == 400


def test_rate_limiter_evicts_idle_entries() -> None:
    now = [1000.0]
    rl = RateLimiter(clock=lambda: now[0])
    for i in range(50):
        rl.hit(f"k{i}", 10, 1000)
    assert len(rl._entries) == 50
    now[0] += 120  # past the window and past the sweep interval
    rl.hit("fresh", 10, 1000)
    assert len(rl._entries) == 1
