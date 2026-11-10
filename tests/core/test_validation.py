"""P4: the class-validator message contract, pinned by Node goldens."""

from __future__ import annotations

import math
import re
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import BaseModel

from app.core.errors import ValidationFailed
from app.core.validation import (
    FieldSpec,
    Schema,
    is_email,
    is_int,
    is_string,
    is_uuid,
    js_number,
    max_length,
    min_length,
    normalize_email,
    validate_dict,
    validate_into,
)

# src/auth/dto/login.dto.ts
LOGIN = Schema(
    [
        FieldSpec(
            "email",
            [is_email("Please provide a valid email address")],
            transforms=[normalize_email],
        ),
        FieldSpec("password", [is_string()]),
    ]
)

# src/user/dto/create-user.dto.ts (decorator order top to bottom)
REGISTER = Schema(
    [
        FieldSpec("fullName", [is_string()]),
        FieldSpec(
            "email",
            [is_email("Please provide a valid email address")],
            transforms=[normalize_email],
        ),
        FieldSpec(
            "password",
            [
                is_string(),
                min_length(8, "Password must be at least 8 characters"),
                max_length(72, "Password must not exceed 72 characters"),
            ],
        ),
        FieldSpec("country", [is_string()]),
        FieldSpec("countryCode", [is_string(), max_length(10)], optional=True),
        FieldSpec("zipCode", [is_string()], optional=True),
    ]
)


class LoginModel(BaseModel):
    email: str
    password: str


# ─── goldens captured from Node on 2026-11-10 ────────────────────────────────
def test_login_empty_body_golden() -> None:
    assert validate_dict({}, LOGIN.fields) == [
        "Please provide a valid email address",
        "password must be a string",
    ]


def test_login_unknown_property_first_golden() -> None:
    # Node golden: `password: 5` is implicitly converted to "5" and passes IsString
    assert validate_dict({"email": "x", "password": 5, "foo": 1}, LOGIN.fields) == [
        "property foo should not exist",
        "Please provide a valid email address",
    ]


def test_register_empty_golden_reverse_decorator_order() -> None:
    assert validate_dict({}, REGISTER.fields) == [
        "fullName must be a string",
        "Please provide a valid email address",
        "Password must not exceed 72 characters",
        "Password must be at least 8 characters",
        "password must be a string",
        "country must be a string",
    ]


def test_register_bad_golden() -> None:
    # Node golden: `country: 1` → "1" (implicit conversion), so only two messages
    body = {"fullName": "", "email": "nope", "password": "short", "country": 1}
    assert validate_dict(body, REGISTER.fields) == [
        "Please provide a valid email address",
        "Password must be at least 8 characters",
    ]


def test_implicit_conversion_like_class_transformer() -> None:
    from app.core.validation import js_boolean, js_number, js_string

    assert js_string(5) == "5" and js_string(True) == "true" and js_string(2.0) == "2"
    assert (
        js_string([1, "a", None]) == "1,a," and js_string({"a": 1}) == "[object Object]"
    )
    assert js_string(None) is None
    assert js_number("12") == 12 and js_number(" 1.5 ") == 1.5 and js_number("") == 0
    assert js_number(True) == 1 and js_number([]) == 0 and js_number(["7"]) == 7
    assert math.isnan(js_number("abc")) and math.isnan(js_number({}))
    assert js_boolean("false") is True and js_boolean("") is False
    assert js_boolean(0) is False and js_boolean(2) is True and js_boolean(None) is None
    # null is NOT converted: IsString still fails
    assert validate_dict({"email": "a@b.co", "password": None}, LOGIN.fields) == [
        "password must be a string"
    ]
    # a number-typed query field: "abc" → NaN → not an integer
    spec = FieldSpec("limit", [is_int()], kind="number")
    assert spec.check("12") == [] and spec.check("abc") == [
        "limit must be an integer number"
    ]


def test_optional_skips_rules_on_null_and_missing() -> None:
    base = {
        "fullName": "A",
        "email": "a@b.co",
        "password": "longenough",
        "country": "US",
    }
    assert validate_dict(base, REGISTER.fields) == []
    assert validate_dict({**base, "zipCode": None}, REGISTER.fields) == []
    assert validate_dict({**base, "zipCode": 12}, REGISTER.fields) == []  # → "12"
    assert (
        validate_dict({**base, "zipCode": {}}, REGISTER.fields) == []
    )  # → "[object Object]"


def test_transform_runs_before_rule_and_into_model() -> None:
    m = validate_into({"email": "  A@B.CO ", "password": "x"}, LOGIN, LoginModel)
    assert m.email == "a@b.co"


def test_validate_into_raises_400_list() -> None:
    with pytest.raises(ValidationFailed) as exc:
        validate_into({}, LOGIN, LoginModel)
    assert exc.value.status == 400
    assert isinstance(exc.value.message, list)


# ─── properties ──────────────────────────────────────────────────────────────
json_scalars = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(),
    st.floats(allow_nan=False),
    st.text(max_size=10),
)
bodies = st.dictionaries(st.text(min_size=1, max_size=8), json_scalars, max_size=6)


@settings(max_examples=200)
@given(bodies)
def test_unknown_keys_reported_first_one_each(body: dict[str, Any]) -> None:
    out = validate_dict(body, LOGIN.fields)
    unknown = [k for k in body if k not in LOGIN.known]
    assert out[: len(unknown)] == [f"property {k} should not exist" for k in unknown]
    assert all(isinstance(m, str) and m for m in out)


@settings(max_examples=200)
@given(st.text(max_size=20))
def test_uuid_rule_only_accepts_v4(s: str) -> None:
    import uuid

    msg = is_uuid()("id", s)
    try:
        ok = uuid.UUID(s).version == 4
    except ValueError:
        ok = False
    assert (msg is None) == ok


@given(st.one_of(st.integers(), st.text(max_size=6), st.floats(allow_nan=False)))
def test_number_coercion_then_is_int_is_sound(v: Any) -> None:
    """`Number(v)` then `@IsInt`: accepted iff the converted value is a finite
    integer-valued number (Number.isInteger), exactly as Nest + class-validator."""
    converted = js_number(v)
    msg = is_int()("n", converted)
    accepted = msg is None
    if isinstance(v, int) and not isinstance(v, bool):
        assert accepted
    elif isinstance(v, str):
        s = v.strip()
        if s == "":
            assert accepted  # Number("") === 0
        elif re.fullmatch(r"[+-]?[0-9]+", s):
            assert accepted
        else:
            # whatever else was accepted must be a finite integer-valued number
            assert not accepted or (
                isinstance(converted, int | float)
                and math.isfinite(converted)
                and float(converted).is_integer()
            )
