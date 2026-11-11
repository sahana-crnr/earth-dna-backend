"""Success contract: the NestJS `ResponseInterceptor` envelope.

    {statusCode, message: "Success", data, timestamp}

Used as the default response class, so every handler returns its plain value
and the wrapping is done once here. Handlers that must send something else
(HTML share page, 204 No Content) return a Response themselves and bypass it.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse

from app.core.time import now_iso


class EnvelopedJSONResponse(JSONResponse):
    # Express sent `application/json; charset=utf-8`; keep the exact header.
    media_type = "application/json; charset=utf-8"

    def render(self, content: Any) -> bytes:
        return super().render(
            {
                "statusCode": self.status_code,
                "message": "Success",
                "data": content,
                "timestamp": now_iso(),
            }
        )


def envelope(data: Any, status: int = 200) -> dict[str, Any]:
    """The same shape as a plain dict, for tests and the parity harness."""
    return {
        "statusCode": status,
        "message": "Success",
        "data": data,
        "timestamp": now_iso(),
    }
