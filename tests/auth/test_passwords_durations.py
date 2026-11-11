"""bcrypt interop with the Node service and `ms` duration grammar."""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.core.durations import parse_ms, parse_seconds
from app.core.passwords import hash_password, verify_password

# `node -e "console.log(require('bcrypt').hashSync('Passw0rd!xyz',10))"` on 2026-11-10
NODE_HASH = "$2b$10$LIlCIrThharhgAQF81QIVOb6o9/Falspj4jhWtpjfKH8r8upc80Bi"


def test_node_hash_verifies_here() -> None:
    assert verify_password("Passw0rd!xyz", NODE_HASH)
    assert not verify_password("Passw0rd!xyz ", NODE_HASH)
    assert not verify_password("x", None)


def test_python_hash_has_node_shape() -> None:
    h = hash_password("hello world 123")
    assert h.startswith("$2b$10$") and len(h) == 60
    assert verify_password("hello world 123", h)


@settings(max_examples=30, deadline=None)
@given(st.text(min_size=1, max_size=200))
def test_roundtrip_any_text(pw: str) -> None:
    assert verify_password(pw, hash_password(pw))


def test_72_byte_truncation_like_node() -> None:
    base = "a" * 72
    assert verify_password(base + "tail", hash_password(base))


@pytest.mark.parametrize(
    ("raw", "ms"),
    [
        ("24h", 86_400_000),
        ("15m", 900_000),
        ("30d", 2_592_000_000),
        ("900", 900),
        ("1.5h", 5_400_000),
        ("2 days", 172_800_000),
    ],
)
def test_parse_ms(raw: str, ms: int) -> None:
    assert parse_ms(raw) == ms


def test_parse_seconds_jsonwebtoken_semantics() -> None:
    assert parse_seconds("24h") == 86_400
    assert parse_seconds(3600) == 3600
    assert parse_seconds("3600") == 3  # a numeric *string* is ms in jsonwebtoken


@given(
    st.integers(min_value=0, max_value=10_000), st.sampled_from(["s", "m", "h", "d"])
)
def test_units_scale(n: int, unit: str) -> None:
    factor = {"s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}[unit]
    assert parse_ms(f"{n}{unit}") == n * factor


@pytest.mark.parametrize("bad", ["", "abc", "1 fortnight", "h"])
def test_bad_durations_raise(bad: str) -> None:
    with pytest.raises(ValueError, match="invalid duration"):
        parse_ms(bad)
