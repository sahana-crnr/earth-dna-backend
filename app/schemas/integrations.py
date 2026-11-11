"""F7 admin integration update body (src/integrations/dto/update-integration.dto.ts)."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

from app.core.validation import (
    FieldSpec,
    Schema,
    custom,
    is_boolean,
    is_string,
    matches,
    max_length,
)

AUTH_REF_PATTERN = r"^earthdna\/[A-Za-z0-9/_+=.@-]+$"
_HOST = re.compile(
    r"^(localhost|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+|\d{1,3}(\.\d{1,3}){3})$"
)


def is_https_url(v: Any) -> bool:
    """validator.js isURL with protocols=['https'], require_protocol, disallow_auth,
    no query components, no fragments."""
    if not isinstance(v, str) or not v or len(v) > 2048:
        return False
    try:
        parts = urlsplit(v)
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username or parts.password:
        return False
    if parts.query or parts.fragment or "?" in v or "#" in v:
        return False
    host = parts.hostname or ""
    if not _HOST.match(host):
        return False
    try:
        port = parts.port
    except ValueError:  # ":99999" or ":abc"
        return False
    return not (port is not None and not (0 < port < 65536))


def length(min_len: int, max_len: int) -> Any:
    def rule(name: str, v: Any) -> str | None:
        if not isinstance(v, str):
            return f"{name} must be longer than or equal to {min_len} characters"
        if len(v) < min_len:
            return f"{name} must be longer than or equal to {min_len} characters"
        if len(v) > max_len:
            return f"{name} must be shorter than or equal to {max_len} characters"
        return None

    return rule


UPDATE_INTEGRATION = Schema(
    [
        FieldSpec(
            "baseUrl",
            [
                custom(
                    is_https_url,
                    "baseUrl must be an https URL without credentials, query string or fragment",
                ),
                max_length(2048),
            ],
            optional=True,
            kind="any",
        ),
        FieldSpec("version", [is_string(), length(1, 64)], optional=True, kind="any"),
        FieldSpec(
            "authRef",
            [
                is_string(),
                length(1, 255),
                matches(
                    AUTH_REF_PATTERN,
                    'authRef must be a secret name starting with "earthdna/" (letters, digits and /_+=.@- only)',
                ),
            ],
            optional=True,
            kind="any",
        ),
        FieldSpec("enabled", [is_boolean()], optional=True, kind="any"),
    ]
)
