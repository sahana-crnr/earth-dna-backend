"""F4-F7 tables: `shoes`, `shoe_photos`, `shoe_shares`, `shoe_feedback`."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    CHAR,
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
    ActionTaken,
    Base,
    FeedbackType,
    RecommendedAction,
    ResaleBucket,
    ShoeConditionCode,
    ShoeGender,
    ShoePhotoSource,
    ShoeView,
    ValueSource,
    created_at,
    updated_at,
    uuid_pk,
)


def _uuid_fk(
    column: str, target: str, name: str, ondelete: str, nullable: bool = True
) -> Any:
    return mapped_column(
        column,
        pg.UUID(as_uuid=True),
        ForeignKey(target, ondelete=ondelete, name=name),
        nullable=nullable,
    )


class Shoe(Base):
    __tablename__ = "shoes"
    __table_args__ = (
        UniqueConstraint("scanShoeId", name="UQ_shoes_scan_shoe"),
        Index("IDX_shoes_user_action", "userId", "actionTaken"),
        Index("IDX_shoes_user_bucket", "userId", "resaleBucket"),
        Index("IDX_shoes_user_deleted", "userId", "deletedAt"),
        Index("IDX_shoes_user_recommended", "userId", "recommendedAction"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = _uuid_fk(
        "userId", "users.id", "FK_shoes_user", "CASCADE", False
    )
    scan_shoe_id: Mapped[uuid.UUID | None] = _uuid_fk(
        "scanShoeId", "scan_shoes.id", "FK_shoes_scan_shoe", "SET NULL"
    )
    brand_id: Mapped[uuid.UUID | None] = _uuid_fk(
        "brandId", "catalog_brands.id", "FK_shoes_brand", "SET NULL"
    )
    brand: Mapped[str] = mapped_column(String(120), nullable=False)
    sub_brand: Mapped[str | None] = mapped_column("subBrand", String(120))
    category: Mapped[str | None] = mapped_column(String(100))
    sub_category: Mapped[str | None] = mapped_column("subCategory", String(100))
    model: Mapped[str | None] = mapped_column(String(150))
    colorway: Mapped[str | None] = mapped_column(String(100))
    size_id: Mapped[uuid.UUID | None] = _uuid_fk(
        "sizeId", "catalog_sizes.id", "FK_shoes_size", "SET NULL"
    )
    size: Mapped[str | None] = mapped_column(String(20))
    gender: Mapped[str | None] = mapped_column(ShoeGender)
    condition_code: Mapped[str | None] = mapped_column(
        "conditionCode", ShoeConditionCode
    )
    material: Mapped[str | None] = mapped_column(String(200))
    catalog_product_id: Mapped[uuid.UUID | None] = _uuid_fk(
        "catalogProductId",
        "catalog_products.id",
        "FK_shoes_catalog_product",
        "SET NULL",
    )
    msrp: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    recommended_action: Mapped[str | None] = mapped_column(
        "recommendedAction", RecommendedAction
    )
    action_taken: Mapped[str] = mapped_column(
        "actionTaken",
        ActionTaken,
        nullable=False,
        server_default=text("'none'::action_taken"),
    )
    action_taken_at: Mapped[datetime | None] = mapped_column(
        "actionTakenAt", DateTime(timezone=True)
    )
    resale_min: Mapped[Decimal | None] = mapped_column("resaleMin", Numeric(10, 2))
    resale_max: Mapped[Decimal | None] = mapped_column("resaleMax", Numeric(10, 2))
    resale_currency: Mapped[str] = mapped_column(
        "resaleCurrency", CHAR(3), nullable=False, server_default=text("'USD'::bpchar")
    )
    resale_bucket: Mapped[str | None] = mapped_column("resaleBucket", ResaleBucket)
    demand_note: Mapped[str | None] = mapped_column("demandNote", String(120))
    recommendation_reason: Mapped[str | None] = mapped_column(
        "recommendationReason", String(300)
    )
    value_source: Mapped[str] = mapped_column(
        "valueSource",
        ValueSource,
        nullable=False,
        server_default=text("'static'::value_source"),
    )
    value_source_version: Mapped[str | None] = mapped_column(
        "valueSourceVersion", String(50)
    )
    value_computed_at: Mapped[datetime | None] = mapped_column(
        "valueComputedAt", DateTime(timezone=True)
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        "deletedAt", DateTime(timezone=True)
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()
    shoe_type_id: Mapped[uuid.UUID | None] = _uuid_fk(
        "shoeTypeId", "catalog_shoe_types.id", "FK_shoes_shoe_type", "SET NULL"
    )
    shoe_type: Mapped[str | None] = mapped_column("shoeType", String(60))
    primary_photo_id: Mapped[uuid.UUID | None] = mapped_column(
        "primaryPhotoId",
        pg.UUID(as_uuid=True),
        ForeignKey(
            "shoe_photos.id",
            ondelete="SET NULL",
            name="FK_shoes_primary_photo",
            use_alter=True,
        ),
    )


class ShoePhoto(Base):
    __tablename__ = "shoe_photos"
    __table_args__ = (
        Index("IDX_shoe_photos_shoe_order", "shoeId", "sortOrder"),
        Index(
            "UQ_shoe_photos_scan_photo",
            "shoeId",
            "scanPhotoId",
            unique=True,
            postgresql_where=text('"scanPhotoId" IS NOT NULL'),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    shoe_id: Mapped[uuid.UUID] = _uuid_fk(
        "shoeId", "shoes.id", "FK_shoe_photos_shoe", "CASCADE", False
    )
    source: Mapped[str] = mapped_column(ShoePhotoSource, nullable=False)
    scan_photo_id: Mapped[uuid.UUID | None] = _uuid_fk(
        "scanPhotoId", "scan_photos.id", "FK_shoe_photos_scan_photo", "SET NULL"
    )
    view: Mapped[str | None] = mapped_column(ShoeView)
    s3_key: Mapped[str] = mapped_column("s3Key", String(512), nullable=False)
    content_type: Mapped[str] = mapped_column(
        "contentType", String(50), nullable=False, server_default=text("'image/jpeg'")
    )
    size_bytes: Mapped[int | None] = mapped_column("sizeBytes", Integer)
    sort_order: Mapped[int] = mapped_column(
        "sortOrder", SmallInteger, nullable=False, server_default=text("0")
    )
    created_at: Mapped[datetime] = created_at()


class ShoeShare(Base):
    __tablename__ = "shoe_shares"
    __table_args__ = (
        Index(
            "UQ_shoe_shares_active",
            "shoeId",
            unique=True,
            postgresql_where=text('"revokedAt" IS NULL'),
        ),
        Index("UQ_shoe_shares_token", "token", unique=True),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    shoe_id: Mapped[uuid.UUID] = _uuid_fk(
        "shoeId", "shoes.id", "FK_shoe_shares_shoe", "CASCADE", False
    )
    token: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(
        "expiresAt", DateTime(timezone=True)
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        "revokedAt", DateTime(timezone=True)
    )
    view_count: Mapped[int] = mapped_column(
        "viewCount", Integer, nullable=False, server_default=text("0")
    )
    created_at: Mapped[datetime] = created_at()


class ShoeFeedback(Base):
    __tablename__ = "shoe_feedback"
    __table_args__ = (
        Index("IDX_shoe_feedback_scan_shoe", "scanShoeId"),
        Index("IDX_shoe_feedback_user", "userId"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    scan_shoe_id: Mapped[uuid.UUID | None] = _uuid_fk(
        "scanShoeId", "scan_shoes.id", "FK_shoe_feedback_scan_shoe", "SET NULL"
    )
    shoe_id: Mapped[uuid.UUID | None] = mapped_column("shoeId", pg.UUID(as_uuid=True))
    user_id: Mapped[uuid.UUID | None] = _uuid_fk(
        "userId", "users.id", "FK_shoe_feedback_user", "SET NULL"
    )
    type: Mapped[str] = mapped_column(FeedbackType, nullable=False)
    model_version: Mapped[str | None] = mapped_column("modelVersion", String(64))
    original: Mapped[dict[str, Any]] = mapped_column(pg.JSONB, nullable=False)
    answer: Mapped[dict[str, Any]] = mapped_column(pg.JSONB, nullable=False)
    created_at: Mapped[datetime] = created_at()
