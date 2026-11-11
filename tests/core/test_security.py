"""P7 (reset-time oracle) and the four JwtAuthGuard cases from the Node spec."""

from __future__ import annotations

import math
import time
from datetime import UTC, datetime

import jwt
import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.core.errors import ApiError
from app.core.security import (
    INVALID_TOKEN,
    decode_access_token,
    token_predates_reset,
)
from tests.conftest import TEST_SECRET, make_settings


@given(
    st.integers(min_value=0, max_value=4_000_000_000),
    st.one_of(st.none(), st.integers(min_value=0, max_value=4_000_000_000_000)),
)
def test_oracle_floor_ms(iat: int, changed_ms: int | None) -> None:
    changed = (
        None
        if changed_ms is None
        else datetime.fromtimestamp(changed_ms / 1000, tz=UTC)
    )
    expected = changed_ms is not None and iat < math.floor(changed_ms / 1000)
    assert token_predates_reset(iat, changed) is expected


def test_same_second_login_after_reset_accepted() -> None:
    reset_at = datetime(2026, 10, 21, 10, 0, 0, 500_000, tzinfo=UTC)
    sec = math.floor(reset_at.timestamp())
    assert token_predates_reset(sec - 60, reset_at) is True
    assert token_predates_reset(sec, reset_at) is False
    assert token_predates_reset(None, reset_at) is True
    assert token_predates_reset(None, None) is False


def _sign(payload: dict[str, object], secret: str = TEST_SECRET) -> str:
    return jwt.encode(payload, secret, algorithm="HS256")


def test_node_shaped_token_decodes() -> None:
    s = make_settings()
    now = int(time.time())
    tok = _sign(
        {"sub": "u1", "email": "a@b.c", "role": "USER", "iat": now, "exp": now + 60}
    )
    p = decode_access_token(tok, s)
    assert p["sub"] == "u1" and p["role"] == "USER"


@pytest.mark.parametrize(
    "token",
    [
        "x.y.z",
        _sign({"sub": "u1", "exp": int(time.time()) - 10}),
        _sign({"sub": "u1"}, secret="other-secret-other-secret-other-secret-1"),
        _sign({"email": "no-sub@b.c"}),
    ],
)
def test_invalid_tokens_are_401_with_node_string(token: str) -> None:
    with pytest.raises(ApiError) as exc:
        decode_access_token(token, make_settings())
    assert exc.value.status == 401
    assert exc.value.message == INVALID_TOKEN
