"""Baseline: the schema the 12 NestJS/TypeORM migrations built (develop @ 2d12f8a).

On a database the Node service already migrated, `tools/migrate.py` *stamps*
this revision instead of running it, so existing data is untouched. On a fresh
database (local, CI) it creates every table from the ORM models and inserts
the same reference rows the Node migrations inserted. Proven equal to the Node
schema by `alembic check` against a Node-migrated database (U0 step 16).

Revision ID: 0001
Revises:
Create Date: 2026-11-10
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

from app.models import (
    ALL_ENUMS,
    Base,
    CatalogShoeType,
    ConditionMapping,
    Integration,
)

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SHOE_TYPES: tuple[tuple[str, str, int], ...] = (
    ("athletic-shoes", "Athletic Shoes", 1),
    ("casual-shoes", "Casual Shoes", 2),
    ("dress-shoes", "Dress Shoes", 3),
    ("boots", "Boots", 4),
    ("sandals", "Sandals", 5),
    ("slippers", "Slippers", 6),
)

# code, label, gradeLetter, description, filterGroup, sortOrder — final values
# after DropCo2eAndFourGrades (C3 and C4 share the "Heavily Worn" row text).
CONDITION_MAPPINGS: tuple[tuple[str, str, str, str, str, int], ...] = (
    ("C1", "Like New", "A+", "Little to no visible wear", "Great", 1),
    ("C2", "Lightly Worn", "A", "Minor signs of wear, fully functional", "Good", 2),
    ("C3", "Heavily Worn", "B", "Visible wear, still functional", "Fair", 3),
    ("C4", "Heavily Worn", "B", "Visible wear, still functional", "Fair", 4),
    ("C5", "Not wearable", "C", "Significant wear or damage", "Poor", 5),
)

INTEGRATIONS: tuple[str, ...] = ("shoedna", "valuelens")


def upgrade() -> None:
    bind = op.get_bind()
    op.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    for enum in ALL_ENUMS:
        enum.create(bind, checkfirst=True)
    tables = [t for name, t in Base.metadata.tables.items() if name != "migrations"]
    Base.metadata.create_all(bind, tables=tables, checkfirst=True)

    op.bulk_insert(
        CatalogShoeType.__table__,  # type: ignore[arg-type]
        [{"slug": s, "name": n, "sortOrder": o} for s, n, o in SHOE_TYPES],
    )
    op.bulk_insert(
        ConditionMapping.__table__,  # type: ignore[arg-type]
        [
            {
                "code": c,
                "label": lb,
                "gradeLetter": g,
                "description": d,
                "filterGroup": f,
                "sortOrder": o,
            }
            for c, lb, g, d, f, o in CONDITION_MAPPINGS
        ],
    )
    op.bulk_insert(
        Integration.__table__,  # type: ignore[arg-type]
        [{"name": n} for n in INTEGRATIONS],
    )


def downgrade() -> None:
    # Downgrading the baseline would drop every application table. Not a
    # supported operation on a shared database; restore from a snapshot instead.
    raise RuntimeError("downgrade of the baseline schema is not supported")
