"""Structured JSON logs to stdout (SECURITY-03).

One line per request: method, path, status, duration, user id when a token
was accepted, request id. Never headers, bodies, tokens or secret values.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request, Response

REQUEST_ID_HEADER = "X-Request-Id"
_REDACT = ("authorization", "cookie", "password", "token", "secret")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in ("request_id", "method", "path", "status", "ms", "user_id", "ip"):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info and record.exc_info[1] is not None:
            payload["error"] = repr(record.exc_info[1])
            payload["stack"] = self.formatException(record.exc_info)
        return json.dumps(_redact(payload), default=str)


def _redact(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {
            k: ("***" if any(s in str(k).lower() for s in _REDACT) else _redact(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [_redact(x) for x in obj]
    return obj


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    root.setLevel(level.upper())
    # uvicorn's own access log duplicates ours; its error log stays.
    # httpx logs every request URL at INFO; the Graph API carries tokens in
    # the query string, so its lines stay out of the logs.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("uvicorn.access").propagate = False
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True


from app.core.errors import log_path  # noqa: E402

access_log = logging.getLogger("app.access")
_REQUEST_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}")


async def request_logging_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    started = time.perf_counter()
    supplied = request.headers.get(REQUEST_ID_HEADER, "")
    request_id = supplied if _REQUEST_ID.fullmatch(supplied) else uuid.uuid4().hex
    request.state.request_id = request_id
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        response.headers[REQUEST_ID_HEADER] = request_id
        return response
    finally:
        ms = round((time.perf_counter() - started) * 1000, 1)
        user = getattr(request.state, "user", None)
        path = log_path(request)
        access_log.info(
            "%s %s %s",
            request.method,
            path,
            status,
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": path,
                "status": status,
                "ms": ms,
                "user_id": user.get("sub") if isinstance(user, dict) else None,
                "ip": request.client.host if request.client else None,
            },
        )
