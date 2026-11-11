"""F3 catalog tables (`catalog_*`, `condition_mappings`)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
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
    ShoeConditionCode,
    ShoeGender,
    created_at,
    updated_at,
    uuid_pk,
)

TRUE = text("true")
ZERO = text("0")


class CatalogShoeType(Base):
    __tablename__ = "catalog_shoe_types"
    __table_args__ = (Index("UQ_catalog_shoe_types_slug", "slug", unique=True),)

    id: Mapped[uuid.UUID] = uuid_pk()
    slug: Mapped[str] = mapped_column(String(60), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    sort_order: Mapped[int] = mapped_column(
        "sortOrder", SmallInteger, nullable=False, server_default=ZERO
    )
    is_active: Mapped[bool] = mapped_column(
        "isActive", Boolean, nullable=False, server_default=TRUE
    )


class CatalogBrand(Base):
    __tablename__ = "catalog_brands"
    __table_args__ = (UniqueConstraint("slug", name="UQ_catalog_brands_slug"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    slug: Mapped[str] = mapped_column(String(100), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    sort_order: Mapped[int] = mapped_column(
        "sortOrder", SmallInteger, nullable=False, server_default=ZERO
    )
    is_active: Mapped[bool] = mapped_column(
        "isActive", Boolean, nullable=False, server_default=TRUE
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class CatalogCategory(Base):
    __tablename__ = "catalog_categories"
    __table_args__ = (
        UniqueConstraint("slug", name="UQ_catalog_categories_slug"),
        Index("IDX_catalog_categories_shoe_type", "shoeTypeId"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    slug: Mapped[str] = mapped_column(String(100), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    sort_order: Mapped[int] = mapped_column(
        "sortOrder", SmallInteger, nullable=False, server_default=ZERO
    )
    is_active: Mapped[bool] = mapped_column(
        "isActive", Boolean, nullable=False, server_default=TRUE
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()
    shoe_type_id: Mapped[uuid.UUID | None] = mapped_column(
        "shoeTypeId",
        pg.UUID(as_uuid=True),
        ForeignKey(
            "catalog_shoe_types.id",
            ondelete="SET NULL",
            name="FK_catalog_categories_shoe_type",
        ),
    )


class CatalogSubcategory(Base):
    __tablename__ = "catalog_subcategories"
    __table_args__ = (
        UniqueConstraint(
            "categoryId", "slug", name="UQ_catalog_subcategories_category_slug"
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    category_id: Mapped[uuid.UUID] = mapped_column(
        "categoryId",
        pg.UUID(as_uuid=True),
        ForeignKey(
            "catalog_categories.id",
            ondelete="CASCADE",
            name="FK_catalog_subcategories_category",
        ),
        nullable=False,
    )
    slug: Mapped[str] = mapped_column(String(100), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    sort_order: Mapped[int] = mapped_column(
        "sortOrder", SmallInteger, nullable=False, server_default=ZERO
    )
    is_active: Mapped[bool] = mapped_column(
        "isActive", Boolean, nullable=False, server_default=TRUE
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class CatalogBrandSubcategory(Base):
    __tablename__ = "catalog_brand_subcategories"

    brand_id: Mapped[uuid.UUID] = mapped_column(
        "brandId",
        pg.UUID(as_uuid=True),
        ForeignKey(
            "catalog_brands.id",
            ondelete="CASCADE",
            name="FK_catalog_brand_subcategories_brand",
        ),
        primary_key=True,
    )
    subcategory_id: Mapped[uuid.UUID] = mapped_column(
        "subcategoryId",
        pg.UUID(as_uuid=True),
        ForeignKey(
            "catalog_subcategories.id",
            ondelete="CASCADE",
            name="FK_catalog_brand_subcategories_subcategory",
        ),
        primary_key=True,
    )


class CatalogSize(Base):
    __tablename__ = "catalog_sizes"
    __table_args__ = (
        Index(
            "UQ_catalog_sizes_brand_system_label",
            "brandId",
            "system",
            "label",
            unique=True,
            postgresql_where=text('"brandId" IS NOT NULL'),
        ),
        Index(
            "UQ_catalog_sizes_generic_system_label",
            "system",
            "label",
            unique=True,
            postgresql_where=text('"brandId" IS NULL'),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    brand_id: Mapped[uuid.UUID | None] = mapped_column(
        "brandId",
        pg.UUID(as_uuid=True),
        ForeignKey(
            "catalog_brands.id", ondelete="CASCADE", name="FK_catalog_sizes_brand"
        ),
    )
    system: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default=text("'US'")
    )
    label: Mapped[str] = mapped_column(String(20), nullable=False)
    sort_order: Mapped[int] = mapped_column(
        "sortOrder", SmallInteger, nullable=False, server_default=ZERO
    )


class CatalogProduct(Base):
    __tablename__ = "catalog_products"
    __table_args__ = (
        UniqueConstraint("sku", name="UQ_catalog_products_sku"),
        Index(
            "IDX_catalog_products_brand_lower_model",
            "brandId",
            text("lower((model)::text)"),
        ),
        Index("IDX_catalog_products_brand_model", "brandId", "model"),
        Index("IDX_catalog_products_brand_size", "brandId", "size"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    brand_id: Mapped[uuid.UUID] = mapped_column(
        "brandId",
        pg.UUID(as_uuid=True),
        ForeignKey(
            "catalog_brands.id", ondelete="CASCADE", name="FK_catalog_products_brand"
        ),
        nullable=False,
    )
    sku: Mapped[str] = mapped_column(String(40), nullable=False)
    model: Mapped[str | None] = mapped_column(String(200))
    model_code: Mapped[str | None] = mapped_column("modelCode", String(100))
    category: Mapped[str | None] = mapped_column(String(100))
    sub_category: Mapped[str | None] = mapped_column("subCategory", String(100))
    silhouette: Mapped[str | None] = mapped_column(String(100))
    gender: Mapped[str | None] = mapped_column(ShoeGender)
    colour: Mapped[str | None] = mapped_column(String(200))
    size: Mapped[str | None] = mapped_column(String(20))
    size_raw: Mapped[str | None] = mapped_column("sizeRaw", String(120))
    msrp: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    release_date: Mapped[date | None] = mapped_column("releaseDate", Date)
    title: Mapped[str | None] = mapped_column(String(500))
    source: Mapped[str] = mapped_column(
        String(40), nullable=False, server_default=text("'import'")
    )
    is_active: Mapped[bool] = mapped_column(
        "isActive", Boolean, nullable=False, server_default=TRUE
    )
    imported_at: Mapped[datetime] = mapped_column(
        "importedAt",
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )


class ConditionMapping(Base):
    __tablename__ = "condition_mappings"

    code: Mapped[str] = mapped_column(ShoeConditionCode, primary_key=True)
    label: Mapped[str] = mapped_column(String(40), nullable=False)
    grade_letter: Mapped[str] = mapped_column("gradeLetter", String(2), nullable=False)
    description: Mapped[str] = mapped_column(String(120), nullable=False)
    filter_group: Mapped[str] = mapped_column("filterGroup", String(20), nullable=False)
    sort_order: Mapped[int] = mapped_column(
        "sortOrder", SmallInteger, nullable=False, server_default=ZERO
    )
