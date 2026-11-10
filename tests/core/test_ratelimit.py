"""P6: model-based check of the limiter against a reference sliding window."""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from app.core.ratelimit import RateLimiter


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@settings(max_examples=200)
@given(
    limit=st.integers(min_value=1, max_value=8),
    ttl_ms=st.integers(min_value=1000, max_value=60_000),
    gaps=st.lists(st.floats(min_value=0, max_value=120), min_size=1, max_size=40),
)
def test_matches_reference_model(limit: int, ttl_ms: int, gaps: list[float]) -> None:
    clock = Clock()
    rl = RateLimiter(clock=clock)
    ttl = ttl_ms / 1000
    hits: list[float] = []
    blocked_until = 0.0
    for gap in gaps:
        clock.t += gap
        now = clock.t
        v = rl.hit("k", limit, ttl_ms)
        if blocked_until > now:
            assert v.allowed is False
            continue
        hits = [h for h in hits if h + ttl > now]
        hits.append(now)
        if len(hits) > limit:
            blocked_until = now + ttl
            assert v.allowed is False
            assert v.retry_after_seconds >= 1
        else:
            assert v.allowed is True
            assert v.remaining == limit - len(hits)
            assert 1 <= v.reset_seconds <= -(-ttl_ms // 1000)


def test_first_n_pass_then_block_then_reset() -> None:
    clock = Clock()
    rl = RateLimiter(clock=clock)
    assert [rl.hit("a", 3, 10_000).allowed for _ in range(5)] == [
        True,
        True,
        True,
        False,
        False,
    ]
    clock.t += 10.0
    assert rl.hit("a", 3, 10_000).allowed is True
    assert rl.hit("b", 3, 10_000).remaining == 2  # independent key
