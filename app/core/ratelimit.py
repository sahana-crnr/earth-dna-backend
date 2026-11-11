"""Rate limiting with the same observable behaviour as `@nestjs/throttler` v6.

- One counter per (route, client IP). Nest keys by handler + tracker (IP).
- Sliding log: each hit expires `ttl` after it was made; the response carries
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds
  until the oldest hit expires).
- Over the limit: 429 `ThrottlerException: Too Many Requests`, `Retry-After`
  seconds, and the key is blocked for `ttl` (Nest's default blockDuration).
- Global default from THROTTLE_LIMIT / THROTTLE_TTL_MS; `@throttle(limit, ttl)`
  on a handler replaces it for that route, as `@Throttle({default: ...})` did.

In-memory, per process, like the Node service. The client IP is the socket
peer, which is what Express `req.ip` gave without `trust proxy`.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from fastapi import Request, Response
from fastapi.routing import APIRoute

from app.core.errors import ApiError

THROTTLE_ATTR = "__throttle__"
F = TypeVar("F", bound=Callable[..., Any])


@dataclass(frozen=True)
class Throttle:
    limit: int
    ttl_ms: int


def throttle(limit: int, ttl_ms: int = 60000) -> Callable[[F], F]:
    """Per-route override, mirrors `@Throttle({ default: { limit, ttl } })`."""

    def deco(fn: F) -> F:
        setattr(fn, THROTTLE_ATTR, Throttle(limit, ttl_ms))
        return fn

    return deco


@dataclass(frozen=True)
class Verdict:
    allowed: bool
    limit: int
    remaining: int
    reset_seconds: int
    retry_after_seconds: int = 0


def _ceil_seconds(seconds: float) -> int:
    """Nest computes in integer milliseconds; round to ms first so float noise
    (1.0000000000000002) does not turn a 1 s window into 2 s."""
    return max(1, math.ceil(round(seconds * 1000) / 1000))


class _Entry:
    __slots__ = ("blocked_until", "expires_at", "hits")

    def __init__(self) -> None:
        self.hits: deque[float] = deque()
        self.blocked_until: float = 0.0
        self.expires_at: float = 0.0


SWEEP_INTERVAL_S = 60.0


class RateLimiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, _Entry] = {}
        self._next_sweep: float = 0.0

    def hit(self, key: str, limit: int, ttl_ms: int) -> Verdict:
        ttl = ttl_ms / 1000.0
        now = self._clock()
        with self._lock:
            if now >= self._next_sweep:
                self._sweep(now)
            entry = self._entries.get(key)
            if entry is None:
                entry = _Entry()
                self._entries[key] = entry
            # an entry is garbage once its block and its window have both passed
            entry.expires_at = max(entry.expires_at, now + 2 * ttl)
            if entry.blocked_until > now:
                retry = _ceil_seconds(entry.blocked_until - now)
                return Verdict(False, limit, 0, retry, retry)
            while entry.hits and entry.hits[0] + ttl <= now:
                entry.hits.popleft()
            entry.hits.append(now)
            total = len(entry.hits)
            reset = _ceil_seconds(entry.hits[0] + ttl - now)
            if total > limit:
                entry.blocked_until = now + ttl
                retry = _ceil_seconds(ttl)
                return Verdict(False, limit, 0, reset, retry)
            return Verdict(True, limit, limit - total, reset)

    def _sweep(self, now: float) -> None:
        """Drop idle entries so one counter per (route, IP) cannot grow forever."""
        dead = [
            k
            for k, e in self._entries.items()
            if e.expires_at <= now and e.blocked_until <= now
        ]
        for k in dead:
            del self._entries[k]
        self._next_sweep = now + SWEEP_INTERVAL_S

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


limiter = RateLimiter()


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


class ThrottledRoute(APIRoute):
    """APIRoute that applies the throttle before the handler and stamps headers.

    Routers must be created with `route_class=ThrottledRoute`; `app.main`
    does that for every router it mounts.
    """

    def get_route_handler(self) -> Callable[[Request], Any]:
        original = super().get_route_handler()
        override: Throttle | None = getattr(self.endpoint, THROTTLE_ATTR, None)

        async def handler(request: Request) -> Response:
            settings = request.app.state.settings
            limit = override.limit if override else settings.THROTTLE_LIMIT
            ttl_ms = override.ttl_ms if override else settings.THROTTLE_TTL_MS
            key = f"{self.path}|{','.join(sorted(self.methods or []))}|{client_ip(request)}"
            verdict = limiter.hit(key, limit, ttl_ms)
            if not verdict.allowed:
                raise ApiError(
                    429,
                    None,
                    "ThrottlerException: Too Many Requests",
                    headers={"Retry-After": str(verdict.retry_after_seconds)},
                )
            response = await original(request)
            response.headers["X-RateLimit-Limit"] = str(verdict.limit)
            response.headers["X-RateLimit-Remaining"] = str(verdict.remaining)
            response.headers["X-RateLimit-Reset"] = str(verdict.reset_seconds)
            return response

        return handler
