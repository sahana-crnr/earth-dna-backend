"""Database engine and per-request session (SQLAlchemy 2 async over asyncpg).

`DB_SSL=true` means what TypeORM's `ssl: { rejectUnauthorized: false }` meant:
encrypt, do not verify the certificate (the RDS endpoint inside the VPC).
"""

from __future__ import annotations

import os
import ssl
from collections.abc import AsyncIterator
from typing import Any

from fastapi import Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.settings import Settings


def make_engine(settings: Settings) -> AsyncEngine:
    connect_args: dict[str, Any] = {}
    is_cloud_db = (
        settings.DB_SSL
        or "neon.tech" in settings.database_url
        or "render.com" in settings.database_url
        or "sslmode" in (os.environ.get("DATABASE_URL") or "")
    )
    if is_cloud_db:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        connect_args["ssl"] = ctx
    return create_async_engine(
        settings.database_url,
        echo=settings.DB_LOGGING,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        connect_args=connect_args,
    )


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """One session per request. Services open their own transactions."""
    factory: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    async with factory() as session:
        yield session
