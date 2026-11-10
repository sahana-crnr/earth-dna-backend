"""Error contract: the exact JSON the NestJS `AllExceptionsFilter` produced.

    {statusCode, timestamp, path, message, code?, details?}

`message` is a string, or a list of strings for validation errors (400).
Unknown exceptions become a 500 with `Internal server error` and no detail
(SECURITY-09: no stack traces, paths or framework versions to the client).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.time import now_iso

log = logging.getLogger("app.errors")

Message = str | list[str]


class ApiError(Exception):
    """Business error with a stable `code` the app can switch on."""

    def __init__(
        self,
        status: int,
        code: str | None,
        message: Message,
        details: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message if isinstance(message, str) else "; ".join(message))
        self.status = status
        self.code = code
        self.message = message
        self.details = dict(details) if details is not None else None
        self.headers = dict(headers) if headers else None


class ValidationFailed(ApiError):
    """400 with the class-validator style message list."""

    def __init__(self, messages: list[str]) -> None:
        super().__init__(400, None, messages)


def unauthorized(message: str = "Unauthorized") -> ApiError:
    return ApiError(401, None, message)


def forbidden_role() -> ApiError:
    return ApiError(
        403, "FORBIDDEN_ROLE", "You do not have permission to access this resource"
    )


def request_path(request: Request) -> str:
    """Express `req.url`: path plus query string (goes into the error body)."""
    path = request.url.path
    if request.url.query:
        path = f"{path}?{request.url.query}"
    return path


_SHARE_TOKEN = re.compile(r"(/s/)[^/?#]+")


def log_path(request: Request) -> str:
    """Path for log lines: no query string (reset tokens live there) and the
    public share token masked (the URL is the capability)."""
    return _SHARE_TOKEN.sub(r"\1***", request.url.path)


def error_body(
    status: int,
    path: str,
    message: Message,
    code: str | None = None,
    details: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "statusCode": status,
        "timestamp": now_iso(),
        "path": path,
        "message": message,
    }
    if code is not None:
        body["code"] = code
    if details is not None:
        body["details"] = dict(details)
    return body


def error_response(
    request: Request,
    status: int,
    message: Message,
    code: str | None = None,
    details: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=error_body(status, request_path(request), message, code, details),
        headers=dict(headers) if headers else None,
        media_type="application/json; charset=utf-8",
    )


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        log.warning(
            "%s %s -> %s %s",
            request.method,
            log_path(request),
            exc.status,
            exc.code or "",
        )
        return error_response(
            request, exc.status, exc.message, exc.code, exc.details, exc.headers
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        status = exc.status_code
        message: Message = str(exc.detail)
        # Express has no 405 and no generic "Not Found": any unmatched
        # method+path is `404 Cannot GET /path`.
        if status in (404, 405) and exc.detail in ("Not Found", "Method Not Allowed"):
            status = 404
            message = f"Cannot {request.method} {request_path(request)}"
        headers = dict(exc.headers) if exc.headers else None
        return error_response(request, status, message, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _fastapi_validation(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Only reached by a route that still uses FastAPI's own parsing; the
        # contract routes go through app.core.validation and raise
        # ValidationFailed. Keep the Nest shape anyway (400, message list).
        messages = [
            f"{'.'.join(str(p) for p in err.get('loc', ())[1:]) or 'body'} is invalid"
            for err in exc.errors()
        ]
        log.warning("unmapped validation error on %s: %s", log_path(request), exc)
        return error_response(request, 400, messages or ["Bad Request"])

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("%s %s -> 500", request.method, log_path(request))
        # This handler runs outside the middleware stack, so the headers the
        # middlewares add (CORS, nosniff, request id) are set here by hand.
        settings = request.app.state.settings
        origin = request.headers.get("origin")
        headers = {"X-Content-Type-Options": "nosniff"}
        if not settings.CORS_ORIGINS:
            headers["Access-Control-Allow-Origin"] = "*"
        elif origin and origin in settings.CORS_ORIGINS:
            headers["Access-Control-Allow-Origin"] = origin
            headers["Vary"] = "Origin"
        request_id = getattr(request.state, "request_id", None)
        if request_id:
            headers["X-Request-Id"] = str(request_id)
        return error_response(request, 500, "Internal server error", headers=headers)
