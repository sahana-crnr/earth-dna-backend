"""Time helpers that reproduce the JavaScript formats the app already parses."""

from __future__ import annotations

from datetime import UTC, datetime


def utcnow() -> datetime:
    return datetime.now(UTC)


def to_js_iso(dt: datetime) -> str:
    """`Date.prototype.toISOString()`: `2026-11-10T04:13:19.150Z`.

    Milliseconds (3 digits) and a literal `Z`, never `+00:00`. Naive datetimes
    are taken as UTC, like a `Date` built from a UTC epoch.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    dt = dt.astimezone(UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return to_js_iso(utcnow())
