"""Validation messages for every auth body, pinned by Node goldens (2026-11-10)."""

from __future__ import annotations

from app.core.validation import validate_dict
from app.schemas.auth import (
    APPLE_LOGIN,
    FACEBOOK_LOGIN,
    FORGOT_PASSWORD,
    GOOGLE_LOGIN,
    REFRESH_TOKEN,
    RESET_PASSWORD,
)


def test_refresh_empty() -> None:
    assert validate_dict({}, REFRESH_TOKEN.fields) == [
        "refreshToken should not be empty",
        "refreshToken must be a string",
    ]


def test_google_empty() -> None:
    assert validate_dict({}, GOOGLE_LOGIN.fields) == [
        "idToken is required",
        "idToken must be a string",
    ]


def test_facebook_empty() -> None:
    assert validate_dict({}, FACEBOOK_LOGIN.fields) == [
        "accessToken must be shorter than or equal to 4096 characters",
        "accessToken is required",
        "accessToken must be a string",
    ]


def test_apple_empty_with_bad_name() -> None:
    # Node golden: `fullName: 5` → "5" (implicit conversion) and passes
    assert validate_dict({"fullName": 5}, APPLE_LOGIN.fields) == [
        "identityToken must be shorter than or equal to 4096 characters",
        "identityToken is required",
        "identityToken must be a string",
    ]


def test_forgot_bad_email_default_message() -> None:
    assert validate_dict({"email": "nope"}, FORGOT_PASSWORD.fields) == [
        "email must be an email"
    ]


def test_reset_empty() -> None:
    assert validate_dict({}, RESET_PASSWORD.fields) == [
        "token should not be empty",
        "token must be a string",
        "newPassword must be longer than or equal to 8 characters",
        "newPassword must be a string",
        "confirmPassword must be longer than or equal to 8 characters",
        "confirmPassword must be a string",
    ]


def test_valid_bodies_pass() -> None:
    assert validate_dict({"refreshToken": "abc"}, REFRESH_TOKEN.fields) == []
    assert (
        validate_dict({"identityToken": "a.b.c", "fullName": "J"}, APPLE_LOGIN.fields)
        == []
    )
    assert (
        validate_dict(
            {"token": "t", "newPassword": "abcdefgh", "confirmPassword": "abcdefgh"},
            RESET_PASSWORD.fields,
        )
        == []
    )
