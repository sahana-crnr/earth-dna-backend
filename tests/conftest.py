"""Shared fixtures. Tests never read the developer's `.env`."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Iterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.core import ratelimit
from app.core.settings import Settings, reset_settings

TEST_SECRET = "test-secret-0123456789abcdef0123456789abcdef"


def make_settings(**overrides: object) -> Settings:
    base: dict[str, object] = {
        "_env_file": None,
        "JWT_SECRET": TEST_SECRET,
        "APP_ENV": "local",
        "DB_HOST": os.environ.get("DB_HOST", "localhost"),
        "DB_PORT": os.environ.get("DB_PORT", "5433"),
        "DB_USERNAME": os.environ.get("DB_USERNAME", "earthdna"),
        "DB_PASSWORD": os.environ.get("DB_PASSWORD", "earthdna"),
        "DB_NAME": os.environ.get("PY_IT_DB_NAME", "earth_dna_py"),
        "DB_LOGGING": False,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def _clean_state() -> Iterator[None]:
    reset_settings()
    ratelimit.limiter.clear()
    yield
    reset_settings()
    ratelimit.limiter.clear()


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
async def client(settings: Settings) -> AsyncIterator[AsyncClient]:
    """App without a live database: the lifespan is skipped, DB-free routes only."""
    from app.main import create_app

    app = create_app(settings)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def db_available() -> bool:
    return os.environ.get("PY_IT_DB") == "1"


requires_db = pytest.mark.skipif(
    not db_available(), reason="set PY_IT_DB=1 with local-infra Postgres running"
)
