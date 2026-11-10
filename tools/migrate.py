"""Migrate, then the container starts the app (replaces dist/database/run-migrations.js).

    python -m tools.migrate            # stamp-or-upgrade, exit 1 on failure

Rules
- Postgres advisory lock 727301 (the same key the Node script used) serialises
  the tasks ECS starts at the same moment: one migrates, the others wait, find
  nothing pending, move on. The lock is session-scoped and released by the
  server if the process dies.
- A database with no `alembic_version` but with TypeORM's `migrations` table
  holding the 12 known Node migrations is *stamped* at baseline `0001` — the
  schema is already there, nothing is created or altered.
- A database that has application tables but neither ledger is *refused*: it
  is not ours to guess at (restore it or stamp it by hand).
- Then `alembic upgrade head` runs whatever is pending.
- Any failure exits non-zero, so a bad migration stops the container instead
  of serving broken queries.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.engine import Connection

from app.core.db import make_engine
from app.core.logging import configure_logging
from app.core.settings import get_settings
from app.models import NODE_MIGRATIONS

MIGRATION_LOCK_KEY = 727301
BASELINE_REVISION = "0001"
REPO_ROOT = Path(__file__).resolve().parent.parent

log = logging.getLogger("tools.migrate")


def node_migrations_applied(conn: Connection) -> list[str]:
    insp = inspect(conn)
    if "migrations" not in insp.get_table_names():
        return []
    rows = conn.execute(text('SELECT name FROM migrations ORDER BY "timestamp"'))
    return [str(r[0]) for r in rows]


def current_revision(conn: Connection) -> str | None:
    return MigrationContext.configure(conn).get_current_revision()


def alembic_config() -> Config:
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    return cfg


def decide(rev: str | None, applied: list[str], app_tables: bool = False) -> str:
    """'stamp' | 'fresh' | 'upgrade' | 'refuse' — pure, so it is unit-tested."""
    if rev is not None:
        return "upgrade"
    if set(NODE_MIGRATIONS).issubset(applied):
        return "stamp"
    if applied or app_tables:
        return "refuse"
    return "fresh"


def has_app_tables(conn: Connection) -> bool:
    names = set(inspect(conn).get_table_names())
    return bool(names & {"users", "scans", "shoes", "catalog_brands"})


async def run() -> int:
    configure_logging(os.environ.get("LOG_LEVEL", "INFO"))
    settings = get_settings()
    engine = make_engine(settings)
    cfg = alembic_config()
    try:
        async with engine.connect() as conn:
            await conn.execute(
                text("SELECT pg_advisory_lock(:k)"), {"k": MIGRATION_LOCK_KEY}
            )
            try:
                rev = await conn.run_sync(current_revision)
                applied = await conn.run_sync(node_migrations_applied)
                tables = await conn.run_sync(has_app_tables)
                action = decide(rev, applied, tables)
                if action == "refuse":
                    log.error(
                        "Schema present but no usable migration ledger "
                        "(TypeORM rows: %s); refusing to guess",
                        applied,
                    )
                    return 1
                if action == "stamp":
                    log.info(
                        "Database was migrated by the Node service (%d TypeORM "
                        "migrations); stamping Alembic baseline %s",
                        len(applied),
                        BASELINE_REVISION,
                    )
                    # env.py runs its own event loop, so Alembic goes to a thread.
                    await asyncio.to_thread(command.stamp, cfg, BASELINE_REVISION)
                elif action == "fresh":
                    log.info("Fresh database: creating the schema")
                else:
                    log.info("Alembic revision before upgrade: %s", rev)
                await asyncio.to_thread(command.upgrade, cfg, "head")
                after = await conn.run_sync(current_revision)
                log.info("Migrations complete — at revision %s", after)
            finally:
                await conn.execute(
                    text("SELECT pg_advisory_unlock(:k)"), {"k": MIGRATION_LOCK_KEY}
                )
    finally:
        await engine.dispose()
    return 0


def main() -> None:
    try:
        sys.exit(asyncio.run(run()))
    except Exception:
        log.exception("Migration failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
