"""Declarative base and the Postgres enum types shared by the tables.

Column names keep the Node camelCase spelling (quoted in Postgres), while the
Python attributes are snake_case. Nothing here changes the schema: the
Alembic baseline is proven against a database migrated by the Node service.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, MetaData, func, text
from sqlalchemy.dialects import postgresql as pg
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# uuid-ossp default, as every Node table used.
UUID_DEFAULT = text("uuid_generate_v4()")
NOW = text("now()")


# TypeORM named every primary key `PK_<table>`; the other constraint names are
# given explicitly on each table.
NAMING = MetaData(naming_convention={"pk": "PK_%(table_name)s"})


class Base(DeclarativeBase):
    metadata = NAMING
    type_annotation_map: dict[Any, Any] = {datetime: DateTime(timezone=True)}


def uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(
        pg.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT
    )


def created_at() -> Mapped[datetime]:
    return mapped_column(
        "createdAt", DateTime(timezone=True), nullable=False, server_default=NOW
    )


def updated_at() -> Mapped[datetime]:
    # TypeORM's @UpdateDateColumn bumps the value on every UPDATE (QueryBuilder
    # updates included); `onupdate` gives Core and ORM updates the same effect.
    return mapped_column(
        "updatedAt",
        DateTime(timezone=True),
        nullable=False,
        server_default=NOW,
        onupdate=func.now(),
    )


# ─── enum types (names and values exactly as in the Node migrations) ─────────
def _enum(name: str, *values: str) -> pg.ENUM:
    return pg.ENUM(*values, name=name, create_type=True)


ActionTaken = _enum("action_taken", "none", "resold", "repaired", "donated", "recycled")
FeedbackType = _enum(
    "feedback_type", "confirmed", "corrected", "condition_suggested", "rescanned"
)
IdentificationOutcome = _enum("identification_outcome", "identified", "failed")
IdentificationSource = _enum("identification_source", "device", "server")
RecommendedAction = _enum("recommended_action", "resell", "repair", "donate", "recycle")
ResaleBucket = _enum(
    "resale_bucket", "under_20", "from_25_to_50", "from_50_to_100", "over_100"
)
ScanShoeStatus = _enum(
    "scan_shoe_status",
    "capturing",
    "complete",
    "analyzing",
    "identified",
    "failed",
    "confirmed",
    "rejected",
)
ScanSource = _enum("scan_source", "camera", "album")
ScanStatus = _enum(
    "scan_status", "draft", "processing", "review", "completed", "abandoned"
)
ShoeConditionCode = _enum("shoe_condition_code", "C1", "C2", "C3", "C4", "C5")
ShoeGender = _enum("shoe_gender", "men", "women", "unisex", "kids")
ShoePhotoSource = _enum("shoe_photo_source", "scan", "upload")
ShoeView = _enum("shoe_view", "top", "right", "left", "sole")
UploadStatus = _enum("upload_status", "pending", "uploaded")
ValueSource = _enum("value_source", "static", "valuelens")

ALL_ENUMS: tuple[pg.ENUM, ...] = (
    ActionTaken,
    FeedbackType,
    IdentificationOutcome,
    IdentificationSource,
    RecommendedAction,
    ResaleBucket,
    ScanShoeStatus,
    ScanSource,
    ScanStatus,
    ShoeConditionCode,
    ShoeGender,
    ShoePhotoSource,
    ShoeView,
    UploadStatus,
    ValueSource,
)
