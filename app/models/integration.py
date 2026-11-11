"""F7 `integrations` (ShoeDNA / ValueLens settings) and TypeORM's `migrations` ledger.

`migrations` is mapped read-only so `tools/migrate.py` can tell a database the
Node service already migrated from a fresh one. Alembic owns the schema from
U0 on; the table itself is left in place and never written again.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects import postgresql as pg
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, updated_at


class Integration(Base):
    __tablename__ = "integrations"
    __table_args__ = (
        CheckConstraint(
            '(NOT enabled) OR ("baseUrl" IS NOT NULL)',
            name="CHK_integrations_enabled_url",
        ),
        CheckConstraint(
            "\"name\" IN ('shoedna','valuelens')", name="CHK_integrations_name"
        ),
    )

    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    base_url: Mapped[str | None] = mapped_column("baseUrl", Text)
    version: Mapped[str | None] = mapped_column(String(64))
    auth_ref: Mapped[str | None] = mapped_column("authRef", String(255))
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        "updatedById",
        pg.UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL", name="FK_integrations_updated_by"),
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


# Ledger rows that mean "this database was built by the Node service"; the
# Alembic baseline is stamped, not run, when all of them are present.
NODE_MIGRATIONS: tuple[str, ...] = (
    "CreateUsersTable1780045191895",
    "CreateRefreshTokensTable1785997681440",
    "AddGoogleAuthSupport1788240000000",
    "AddSocialProviderIds1788500000000",
    "CreateScanTables1790700000000",
    "CreateScanShoeResults1791600000000",
    "CreateCatalogAndShoes1791800000000",
    "DropCo2eAndFourGrades1792000000000",
    "CreateShoePhotosSharesShoeTypes1792100000000",
    "AddUserRole1792200000000",
    "CreateIntegrations1792200000001",
    "NormalizeUserEmails1792300000000",
)


class TypeOrmMigration(Base):
    __tablename__ = "migrations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
