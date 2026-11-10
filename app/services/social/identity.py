"""Shared social sign-in pieces (src/auth/social)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

SocialProvider = Literal["google", "facebook", "apple"]

_JWT_PART = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass(frozen=True)
class SocialIdentity:
    provider: SocialProvider
    provider_user_id: str
    email: str | None
    full_name: str


def resolve_full_name(name: str | None, email: str | None) -> str:
    """Given name, else the e-mail local part, else a fixed fallback."""
    trimmed = (name or "").strip()
    if trimmed:
        return trimmed
    local = (email or "").split("@")[0].strip() if email else ""
    return local or "Earth DNA User"


def looks_like_jwt(token: str) -> bool:
    parts = token.split(".")
    return len(parts) == 3 and all(_JWT_PART.match(p) for p in parts)


def normalise_email(value: object) -> str | None:
    return value.strip().lower() if isinstance(value, str) and value.strip() else None
