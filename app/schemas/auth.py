"""Auth request bodies: Pydantic models + the class-validator specs that pin the
400 messages (decorator order copied from src/auth/dto and src/user/dto)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from app.core.validation import (
    FieldSpec,
    Schema,
    is_email,
    is_not_empty,
    is_string,
    max_length,
    min_length,
    normalize_email,
)

EMAIL_MESSAGE = "Please provide a valid email address"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ─── register (CreateUserDto) ───────────────────────────────────────────────
class RegisterBody(Strict):
    fullName: str
    email: str
    password: str
    country: str
    countryCode: str | None = None
    zipCode: str | None = None


REGISTER = Schema(
    [
        FieldSpec("fullName", [is_string()]),
        FieldSpec("email", [is_email(EMAIL_MESSAGE)], transforms=[normalize_email]),
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


# ─── login ──────────────────────────────────────────────────────────────────
class LoginBody(Strict):
    email: str
    password: str


LOGIN = Schema(
    [
        FieldSpec("email", [is_email(EMAIL_MESSAGE)], transforms=[normalize_email]),
        FieldSpec("password", [is_string()]),
    ]
)


# ─── refresh / logout ───────────────────────────────────────────────────────
class RefreshTokenBody(Strict):
    refreshToken: str


REFRESH_TOKEN = Schema([FieldSpec("refreshToken", [is_string(), is_not_empty()])])


# ─── social ─────────────────────────────────────────────────────────────────
class GoogleLoginBody(Strict):
    idToken: str


GOOGLE_LOGIN = Schema(
    [FieldSpec("idToken", [is_string(), is_not_empty("idToken is required")])]
)


class FacebookLoginBody(Strict):
    accessToken: str


FACEBOOK_LOGIN = Schema(
    [
        FieldSpec(
            "accessToken",
            [is_string(), is_not_empty("accessToken is required"), max_length(4096)],
        )
    ]
)


class AppleLoginBody(Strict):
    identityToken: str
    fullName: str | None = None


APPLE_LOGIN = Schema(
    [
        FieldSpec(
            "identityToken",
            [is_string(), is_not_empty("identityToken is required"), max_length(4096)],
        ),
        FieldSpec("fullName", [is_string(), max_length(255)], optional=True),
    ]
)


# ─── password reset ─────────────────────────────────────────────────────────
class ForgotPasswordBody(Strict):
    email: str


FORGOT_PASSWORD = Schema(
    [FieldSpec("email", [is_email()], transforms=[normalize_email])]
)


class ResetPasswordBody(Strict):
    token: str
    newPassword: str
    confirmPassword: str


RESET_PASSWORD = Schema(
    [
        FieldSpec("token", [is_string(), is_not_empty()]),
        FieldSpec("newPassword", [is_string(), min_length(8)]),
        FieldSpec("confirmPassword", [is_string(), min_length(8)]),
    ]
)
