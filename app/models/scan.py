"""F1/F2 scan tables: `scans`, `scan_shoes`, `scan_photos`, `scan_shoe_results`."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects import postgresql as pg
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import (
    Base,
    IdentificationOutcome,
    IdentificationSource,
    ScanShoeStatus,
    ScanSource,
    ScanStatus,
    ShoeConditionCode,
    ShoeView,
    UploadStatus,
    created_at,
    updated_at,
    uuid_pk,
)


class Scan(Base):
    __tablename__ = "scans"
    __table_args__ = (
        Index("IDX_scans_status_updated", "status", "updatedAt"),
        Index("IDX_scans_user_status", "userId", "status"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        "userId",
        pg.UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE", name="FK_scans_user"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        ScanStatus, nullable=False, server_default=text("'draft'::scan_status")
    )
    source: Mapped[str] = mapped_column(
        ScanSource, nullable=False, server_default=text("'camera'::scan_source")
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        "finishedAt", DateTime(timezone=True)
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()
    hidden_at: Mapped[datetime | None] = mapped_column(
        "hiddenAt", DateTime(timezone=True)
    )


class ScanShoe(Base):
    __tablename__ = "scan_shoes"
    __table_args__ = (
        UniqueConstraint(
            "scanId",
            "position",
            name="UQ_scan_shoes_scan_position",
            deferrable=True,
            initially="DEFERRED",
        ),
        CheckConstraint('"position" > 0', name="CHK_scan_shoes_position"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    scan_id: Mapped[uuid.UUID] = mapped_column(
        "scanId",
        pg.UUID(as_uuid=True),
        ForeignKey("scans.id", ondelete="CASCADE", name="FK_scan_shoes_scan"),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    status: Mapped[str] = mapped_column(
        ScanShoeStatus,
        nullable=False,
        server_default=text("'capturing'::scan_shoe_status"),
    )
    rescan_of_shoe_id: Mapped[uuid.UUID | None] = mapped_column(
        "rescanOfShoeId",
        pg.UUID(as_uuid=True),
        ForeignKey(
            "shoes.id",
            ondelete="SET NULL",
            name="FK_scan_shoes_rescan_of_shoe",
            use_alter=True,
        ),
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class ScanPhoto(Base):
    __tablename__ = "scan_photos"
    __table_args__ = (
        UniqueConstraint("scanShoeId", "view", name="UQ_scan_photos_shoe_view"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    scan_shoe_id: Mapped[uuid.UUID] = mapped_column(
        "scanShoeId",
        pg.UUID(as_uuid=True),
        ForeignKey("scan_shoes.id", ondelete="CASCADE", name="FK_scan_photos_shoe"),
        nullable=False,
    )
    view: Mapped[str] = mapped_column(ShoeView, nullable=False)
    s3_key: Mapped[str] = mapped_column("s3Key", String(512), nullable=False)
    content_type: Mapped[str] = mapped_column(
        "contentType",
        String(50),
        nullable=False,
        server_default=text("'image/jpeg'"),
    )
    bytes: Mapped[int | None] = mapped_column(Integer)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    upload_status: Mapped[str] = mapped_column(
        "uploadStatus",
        UploadStatus,
        nullable=False,
        server_default=text("'uploaded'::upload_status"),
    )
    taken_at: Mapped[datetime | None] = mapped_column(
        "takenAt", DateTime(timezone=True)
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class ScanShoeResult(Base):
    __tablename__ = "scan_shoe_results"
    __table_args__ = (
        UniqueConstraint("scanShoeId", name="UQ_scan_shoe_results_shoe"),
        CheckConstraint(
            "(confidence IS NULL) OR ((confidence >= (0)::numeric) "
            "AND (confidence <= (1)::numeric))",
            name="CHK_scan_shoe_results_confidence",
        ),
        CheckConstraint(
            "(outcome <> 'identified'::identification_outcome) OR "
            "((brand IS NOT NULL) AND (confidence IS NOT NULL))",
            name="CHK_scan_shoe_results_identified",
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    scan_shoe_id: Mapped[uuid.UUID] = mapped_column(
        "scanShoeId",
        pg.UUID(as_uuid=True),
        ForeignKey(
            "scan_shoes.id", ondelete="CASCADE", name="FK_scan_shoe_results_shoe"
        ),
        nullable=False,
    )
    source: Mapped[str] = mapped_column(IdentificationSource, nullable=False)
    outcome: Mapped[str] = mapped_column(
        IdentificationOutcome,
        nullable=False,
        server_default=text("'identified'::identification_outcome"),
    )
    model_version: Mapped[str] = mapped_column(
        "modelVersion", String(64), nullable=False
    )
    brand: Mapped[str | None] = mapped_column(String(120))
    sub_brand: Mapped[str | None] = mapped_column("subBrand", String(120))
    model: Mapped[str | None] = mapped_column(String(160))
    colorway: Mapped[str | None] = mapped_column(String(120))
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))
    condition_code: Mapped[str | None] = mapped_column(
        "conditionCode", ShoeConditionCode
    )
    candidates: Mapped[list[Any]] = mapped_column(
        pg.JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    raw: Mapped[dict[str, Any] | None] = mapped_column(pg.JSONB)
    submitted_at: Mapped[datetime] = mapped_column(
        "submittedAt",
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()
    category: Mapped[str | None] = mapped_column(String(100))
    sub_category: Mapped[str | None] = mapped_column("subCategory", String(100))
    material: Mapped[str | None] = mapped_column(String(200))
