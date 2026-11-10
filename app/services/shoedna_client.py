"""HTTP client for the ShoeDNA identify endpoint (src/scan/shoedna.client.ts)."""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Protocol

import httpx

from app.core.settings import Settings
from app.services.integrations import ActiveIntegration

log = logging.getLogger("app.shoedna")

SHOEDNA_IDENTIFY_PATH = "/identify"
MAX_RESPONSE_BYTES = 256 * 1024


class InferenceTimeoutError(Exception):
    def __init__(self, ms: int) -> None:
        super().__init__(f"ShoeDNA did not answer within {ms} ms")


class InferenceFailedError(Exception):
    def __init__(self, detail: str) -> None:
        super().__init__(f"ShoeDNA call failed: {detail}")


class SecretResolver(Protocol):
    async def resolve(self, name: str) -> str: ...


class ShoeDnaClient:
    def __init__(
        self,
        settings: Settings,
        secrets: SecretResolver,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._timeout_ms = settings.SCAN_INFERENCE_TIMEOUT_MS
        self._secrets = secrets
        self._http = http

    async def identify(self, active: ActiveIntegration, request: dict[str, Any]) -> Any:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if active.auth_ref:
            headers["Authorization"] = (
                f"Bearer {await self._secrets.resolve(active.auth_ref)}"
            )
        if active.version:
            headers["X-Model-Version"] = active.version
        url = active.base_url.rstrip("/") + SHOEDNA_IDENTIFY_PATH
        started = time.monotonic()
        timeout = httpx.Timeout(self._timeout_ms / 1000)
        shoe_id = request.get("shoeId")
        try:
            if self._http is not None:
                res = await self._http.post(
                    url,
                    headers=headers,
                    json=request,
                    timeout=timeout,
                    follow_redirects=False,
                )
            else:
                async with httpx.AsyncClient(
                    timeout=timeout, follow_redirects=False
                ) as client:
                    res = await client.post(url, headers=headers, json=request)
        except httpx.TimeoutException as exc:
            log.warning(
                "shoe %s: ShoeDNA timed out after %d ms", shoe_id, self._timeout_ms
            )
            raise InferenceTimeoutError(self._timeout_ms) from exc
        except httpx.HTTPError as exc:
            log.error("shoe %s: ShoeDNA unreachable: %s", shoe_id, type(exc).__name__)
            raise InferenceFailedError("endpoint unreachable") from exc
        if res.is_redirect:
            raise InferenceFailedError("endpoint unreachable")
        if not res.is_success:
            log.error(
                "shoe %s: ShoeDNA answered %s in %d ms",
                shoe_id,
                res.status_code,
                int((time.monotonic() - started) * 1000),
            )
            raise InferenceFailedError(f"status {res.status_code}")
        declared = res.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
            log.error(
                "shoe %s: ShoeDNA answer over %d bytes", shoe_id, MAX_RESPONSE_BYTES
            )
            raise InferenceFailedError("response too large")
        body = res.content
        if len(body) > MAX_RESPONSE_BYTES:
            log.error(
                "shoe %s: ShoeDNA answer over %d bytes", shoe_id, MAX_RESPONSE_BYTES
            )
            raise InferenceFailedError("response too large")
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise InferenceFailedError("response is not JSON") from exc
        log.info(
            "shoe %s: ShoeDNA answered in %d ms",
            shoe_id,
            int((time.monotonic() - started) * 1000),
        )
        return parsed
