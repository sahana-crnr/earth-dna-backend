"""Application factory. `uvicorn app.main:app --port 1234`.

Mirrors src/main.ts: global prefix, CORS, validation, response envelope,
exception filter, Swagger at /docs. Plus structured logging and basic
security headers (SECURITY-03, SECURITY-04).
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.api import auth, catalog, health, integrations, results, scans, shoes
from app.core.db import make_engine, make_session_factory
from app.core.envelope import EnvelopedJSONResponse
from app.core.errors import error_response, install_exception_handlers
from app.core.logging import configure_logging, request_logging_middleware
from app.core.settings import Settings, get_settings
from app.services.admin_bootstrap import AdminBootstrap
from app.services.analyze import ScanAnalyzeService
from app.services.auth import AuthService
from app.services.catalog import CatalogService
from app.services.integrations import AwsSecretResolver, IntegrationsService
from app.services.mail import MailService
from app.services.refresh_tokens import RefreshTokenService
from app.services.results import ScanResultsBuilder, ScanResultService
from app.services.review import ScanReviewService
from app.services.scan import ScanService
from app.services.scheduler import start_scheduler
from app.services.shoe_views import ShoeViewMapper
from app.services.shoedna_client import ShoeDnaClient
from app.services.shoes import ShoesService
from app.services.shoes_list import ShoesListService
from app.services.social.apple import AppleTokenVerifier
from app.services.social.facebook import FacebookTokenVerifier
from app.services.social.google import GoogleTokenVerifier
from app.services.social.jwks import JwksVerifier
from app.services.storage import PhotoStorage, S3PhotoStorage
from app.services.values import StaticValueProvider

log = logging.getLogger("app.bootstrap")

API_TITLE = "Earth DNA API"
API_DESCRIPTION = "REST API for the Earth DNA platform"
API_VERSION = "1.0"


async def security_headers_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    response = await call_next(request)
    # Express `cors()` sent `Access-Control-Allow-Origin: *` on every response,
    # Origin header or not; Starlette only answers to an Origin. Keep parity.
    settings: Settings = request.app.state.settings
    if not settings.CORS_ORIGINS:
        response.headers.setdefault("Access-Control-Allow-Origin", "*")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.url.scheme == "https":
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


# Express `body-parser` json limit (100kb) and the multipart ceiling the album
# route can ever accept: album photos + manifest + headroom. Anything bigger is
# refused before it is read.
JSON_BODY_LIMIT = 100 * 1024


async def body_limit_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    length = request.headers.get("content-length")
    if length and length.isdigit():
        size = int(length)
        settings: Settings = request.app.state.settings
        ctype = request.headers.get("content-type", "").lower()
        if ctype.startswith("multipart/form-data"):
            limit = (
                settings.SCAN_ALBUM_MAX_PHOTOS * settings.SCAN_PHOTO_MAX_BYTES
                + 2 * 1024 * 1024
            )
            if size > limit:
                return error_response(
                    request,
                    413,
                    "Upload is larger than the allowed size",
                    "PAYLOAD_TOO_LARGE",
                )
        elif size > JSON_BODY_LIMIT:
            return error_response(request, 413, "request entity too large")
    return await call_next(request)


def build_services(
    app: FastAPI, settings: Settings, sessions: Any, storage: PhotoStorage | None = None
) -> None:
    """Wire the service graph once per app (Nest's module providers). Tests pass
    an in-memory `storage`."""
    jwks = JwksVerifier()
    refresh = RefreshTokenService(settings)
    mail = MailService(settings)
    app.state.jwks = jwks
    app.state.refresh_tokens = refresh
    app.state.mail = mail
    app.state.auth = AuthService(
        settings,
        sessions,
        refresh,
        mail,
        GoogleTokenVerifier(settings, jwks),
        FacebookTokenVerifier(settings, jwks),
        AppleTokenVerifier(settings, jwks),
    )
    app.state.admin_bootstrap = AdminBootstrap(settings, sessions, refresh)
    app.state.catalog = CatalogService(settings)
    storage = storage or S3PhotoStorage(settings)
    app.state.storage = storage
    app.state.scans = ScanService(settings, sessions, storage)
    views = ShoeViewMapper(settings, storage)
    values = StaticValueProvider()
    builder = ScanResultsBuilder(views)
    results_svc = ScanResultService(settings, builder)
    app.state.results = results_svc
    integrations_svc = IntegrationsService()
    app.state.integrations = integrations_svc
    app.state.analyze = ScanAnalyzeService(
        settings,
        results_svc,
        integrations_svc,
        storage,
        ShoeDnaClient(settings, AwsSecretResolver(settings)),
    )
    shoes_svc = ShoesService(settings, storage, values)
    app.state.shoes = shoes_svc
    app.state.shoes_list = ShoesListService(views)
    app.state.review = ScanReviewService(settings, builder, shoes_svc, values)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.LOG_LEVEL)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(settings)
        app.state.engine = engine
        sessions = make_session_factory(engine)
        app.state.session_factory = sessions
        try:
            build_services(app, settings, sessions)
            app.state.mail.startup_log()
            # Same as Nest onApplicationBootstrap: sync the admin account, never crash.
            await app.state.admin_bootstrap.run_at_startup()
            # @nestjs/schedule equivalent: the daily draft-abandon job
            app.state.scheduler = start_scheduler(app.state.scans)
        except BaseException:
            await engine.dispose()
            raise
        log.info(
            "Application running on: http://localhost:%s%s (env=%s)",
            settings.PORT,
            settings.api_prefix,
            settings.env,
        )
        try:
            yield
        finally:
            app.state.scheduler.shutdown(wait=False)
            await engine.dispose()

    app = FastAPI(
        title=API_TITLE,
        description=API_DESCRIPTION,
        version=API_VERSION,
        docs_url="/docs",
        openapi_url="/docs-json",
        redoc_url=None,
        default_response_class=EnvelopedJSONResponse,
        lifespan=lifespan,
    )
    app.state.settings = settings

    # ─── CORS (same as Node: any origin unless CORS_ORIGINS is set) ──────────
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS or ["*"],
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],  # Express cors() reflected the requested headers
    )
    app.middleware("http")(security_headers_middleware)
    app.middleware("http")(body_limit_middleware)
    app.middleware("http")(request_logging_middleware)
    if settings.TRUSTED_PROXY_IPS:
        # Outermost: X-Forwarded-For / -Proto from the load balancer become the
        # client address the rate limiter and the share URLs see.
        app.add_middleware(
            ProxyHeadersMiddleware, trusted_hosts=settings.TRUSTED_PROXY_IPS
        )

    install_exception_handlers(app)

    # ─── routers under the global prefix ─────────────────────────────────────
    prefix = settings.api_prefix
    app.include_router(health.router, prefix=prefix)
    app.include_router(auth.router, prefix=prefix)
    app.include_router(catalog.router, prefix=prefix)
    app.include_router(scans.router, prefix=prefix)
    app.include_router(results.router, prefix=prefix)
    app.include_router(shoes.router, prefix=prefix)
    app.include_router(shoes.public, prefix=prefix)
    app.include_router(integrations.router, prefix=prefix)

    return app


app = create_app()
