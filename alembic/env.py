"""Alembic environment: async engine from app settings, metadata from app.models."""

from __future__ import annotations

import asyncio
import logging
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection, pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.settings import get_settings
from app.models import Base

config = context.config
# Alembic's own logging setup only when nothing configured logging yet (the
# CLI). Under tools/migrate.py the JSON logger is already installed and
# `fileConfig` would silence it.
if config.config_file_name is not None and not logging.getLogger().handlers:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata

# TypeORM's own ledger is not ours to manage; it is mapped only so the
# baseline can detect a database the Node service already migrated.
EXCLUDED_TABLES = frozenset({"migrations"})
# Expression indexes (`lower(...)`) cannot be compared by autogenerate: it
# always reports them as changed. They are covered by the pg_dump diff in U0.
EXPRESSION_INDEXES = frozenset(
    {"UQ_users_email_lower", "IDX_catalog_products_brand_lower_model"}
)


def include_object(
    obj: object, name: str | None, type_: str, reflected: bool, compare_to: object
) -> bool:
    if type_ == "table" and name in EXCLUDED_TABLES:
        return False
    return not (type_ == "index" and name in EXPRESSION_INDEXES)


def _url() -> str:
    override = os.environ.get("ALEMBIC_DATABASE_URL")
    return override or get_settings().database_url


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=include_object,
        compare_type=True,
        compare_server_default=True,
        render_as_batch=False,
    )


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def _run_sync(connection: Connection) -> None:
    _configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    settings = get_settings()
    section = config.get_section(config.config_ini_section, {})
    url = _url()
    section["sqlalchemy.url"] = url
    connect_args: dict[str, object] = {}
    is_cloud_db = (
        settings.DB_SSL
        or "neon.tech" in url
        or "render.com" in url
        or "sslmode" in (os.environ.get("DATABASE_URL") or "")
    )
    if is_cloud_db and "ALEMBIC_DATABASE_URL" not in os.environ:
        import ssl

        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        connect_args["ssl"] = ctx
    connectable = async_engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args=connect_args,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(_run_sync)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
