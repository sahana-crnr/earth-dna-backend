"""P1: to_js_iso matches Date.prototype.toISOString and round-trips."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta, timezone

from hypothesis import given, settings
from hypothesis import strategies as st

from app.core.time import to_js_iso

JS_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

aware = st.datetimes(
    min_value=datetime(1971, 1, 1),
    max_value=datetime(2200, 1, 1),
    timezones=st.just(UTC),
)


@settings(max_examples=200)
@given(aware)
def test_shape_and_roundtrip(dt: datetime) -> None:
    out = to_js_iso(dt)
    assert JS_ISO.match(out), out
    back = datetime.fromisoformat(out.replace("Z", "+00:00"))
    assert back == dt.replace(microsecond=(dt.microsecond // 1000) * 1000)


def test_known_value_matches_node_golden() -> None:
    dt = datetime(2026, 11, 10, 4, 13, 19, 150_000, tzinfo=UTC)
    assert to_js_iso(dt) == "2026-11-10T04:13:19.150Z"


def test_naive_is_utc_and_offsets_convert() -> None:
    assert to_js_iso(datetime(2026, 1, 1, 0, 0, 0, 7_000)) == "2026-01-01T00:00:00.007Z"
    ist = timezone(timedelta(hours=5, minutes=30))
    assert (
        to_js_iso(datetime(2026, 1, 1, 5, 30, tzinfo=ist)) == "2026-01-01T00:00:00.000Z"
    )
