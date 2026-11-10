"""`ms`-style durations ("24h", "30d", "15m", "900") → milliseconds.

The Node service fed `JWT_EXPIRES_IN` and `REFRESH_TOKEN_EXPIRES_IN` to the
`ms` package (via jsonwebtoken / RefreshTokenService). Same grammar here so the
same environment values mean the same lifetimes.
"""

from __future__ import annotations

import re

_UNITS: dict[str, float] = {
    "ms": 1,
    "msec": 1,
    "msecs": 1,
    "millisecond": 1,
    "milliseconds": 1,
    "s": 1000,
    "sec": 1000,
    "secs": 1000,
    "second": 1000,
    "seconds": 1000,
    "m": 60_000,
    "min": 60_000,
    "mins": 60_000,
    "minute": 60_000,
    "minutes": 60_000,
    "h": 3_600_000,
    "hr": 3_600_000,
    "hrs": 3_600_000,
    "hour": 3_600_000,
    "hours": 3_600_000,
    "d": 86_400_000,
    "day": 86_400_000,
    "days": 86_400_000,
    "w": 604_800_000,
    "week": 604_800_000,
    "weeks": 604_800_000,
    "y": 31_557_600_000,
    "yr": 31_557_600_000,
    "yrs": 31_557_600_000,
    "year": 31_557_600_000,
    "years": 31_557_600_000,
}

_RX = re.compile(
    r"^(?P<n>-?(?:\d+)?\.?\d+)\s*(?P<u>[a-zA-Z]+)?$",
)


def parse_ms(value: str | int | float) -> int:
    """Milliseconds for an `ms` string. Raises ValueError like `ms` returns NaN."""
    if isinstance(value, int | float) and not isinstance(value, bool):
        return int(value)
    text = str(value).strip()
    if not text or len(text) > 100:
        raise ValueError(f"invalid duration: {value!r}")
    m = _RX.match(text)
    if not m:
        raise ValueError(f"invalid duration: {value!r}")
    n = float(m.group("n"))
    unit = (m.group("u") or "ms").lower()
    if unit not in _UNITS:
        raise ValueError(f"invalid duration unit: {value!r}")
    return int(n * _UNITS[unit])


def parse_seconds(value: str | int | float) -> int:
    """jsonwebtoken `expiresIn` semantics: a number is seconds, a string goes
    through `ms` and is converted to whole seconds."""
    if isinstance(value, int | float) and not isinstance(value, bool):
        return int(value)
    return parse_ms(value) // 1000
