"""Catalog reads and the resolution helpers the review and shoe services use
(src/catalog/catalog.service.ts)."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.catalog import (
    CatalogBrand,
    CatalogCategory,
    CatalogProduct,
    CatalogShoeType,
    CatalogSize,
    CatalogSubcategory,
    ConditionMapping,
)
from app.services.catalog_rules import shoe_type_for, slugify


def like_prefix(q: str) -> str:
    """Escape LIKE wildcards in user text so `%` cannot widen a prefix search."""
    out = []
    for ch in q:
        if ch in ("\\", "%", "_"):
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out) + "%"


async def brands(
    session: AsyncSession, q: str | None, limit: int
) -> list[CatalogBrand]:
    stmt = select(CatalogBrand).where(CatalogBrand.is_active.is_(True))
    if q:
        stmt = stmt.where(CatalogBrand.name.ilike(like_prefix(q), escape="\\"))
    stmt = stmt.order_by(CatalogBrand.name.asc(), CatalogBrand.id.asc()).limit(limit)
    return list((await session.execute(stmt)).scalars())


async def sizes_for_brand(
    session: AsyncSession, brand_id: uuid.UUID | None, limit: int
) -> list[CatalogSize]:
    stmt = select(CatalogSize).where(CatalogSize.system == "US")
    stmt = (
        stmt.where(CatalogSize.brand_id == brand_id)
        if brand_id is not None
        else stmt.where(CatalogSize.brand_id.is_(None))
    )
    return list((await session.execute(stmt.limit(limit))).scalars())


async def shoe_types_with_categories(
    session: AsyncSession,
) -> list[tuple[CatalogShoeType, list[CatalogCategory]]]:
    types = list(
        (
            await session.execute(
                select(CatalogShoeType)
                .where(CatalogShoeType.is_active.is_(True))
                .order_by(CatalogShoeType.sort_order.asc(), CatalogShoeType.name.asc())
            )
        ).scalars()
    )
    if not types:
        return []
    cats = list(
        (
            await session.execute(
                select(CatalogCategory).where(
                    CatalogCategory.shoe_type_id.in_([t.id for t in types])
                )
            )
        ).scalars()
    )
    by_type: dict[uuid.UUID, list[CatalogCategory]] = {t.id: [] for t in types}
    for c in cats:
        if c.shoe_type_id is not None:
            by_type[c.shoe_type_id].append(c)
    return [(t, by_type[t.id]) for t in types]


async def categories_with_subcategories(
    session: AsyncSession, limit: int
) -> list[tuple[CatalogCategory, list[CatalogSubcategory]]]:
    cats = list(
        (
            await session.execute(
                select(CatalogCategory)
                .where(CatalogCategory.is_active.is_(True))
                .order_by(CatalogCategory.name.asc(), CatalogCategory.id.asc())
                .limit(limit)
            )
        ).scalars()
    )
    if not cats:
        return []
    subs = list(
        (
            await session.execute(
                select(CatalogSubcategory).where(
                    CatalogSubcategory.category_id.in_([c.id for c in cats])
                )
            )
        ).scalars()
    )
    by_cat: dict[uuid.UUID, list[CatalogSubcategory]] = {c.id: [] for c in cats}
    for s in subs:
        by_cat[s.category_id].append(s)
    return [(c, by_cat[c.id]) for c in cats]


async def models(
    session: AsyncSession, brand_id: uuid.UUID, q: str | None, limit: int
) -> list[tuple[str, str | None]]:
    p = CatalogProduct
    stmt = (
        select(p.model, func.min(p.model_code))
        .where(p.brand_id == brand_id, p.is_active.is_(True), p.model.is_not(None))
        .group_by(p.model)
        .order_by(p.model.asc())
        .limit(limit)
    )
    if q:
        stmt = stmt.where(p.model.ilike(like_prefix(q), escape="\\"))
    return [(row[0], row[1]) for row in (await session.execute(stmt)).all()]


async def colours(
    session: AsyncSession, brand_id: uuid.UUID, model: str | None, limit: int
) -> list[str]:
    p = CatalogProduct
    stmt = (
        select(p.colour)
        .where(p.brand_id == brand_id, p.is_active.is_(True), p.colour.is_not(None))
        .group_by(p.colour)
        .order_by(p.colour.asc())
        .limit(limit)
    )
    if model:
        stmt = stmt.where(func.lower(p.model) == func.lower(model))
    return [str(row[0]) for row in (await session.execute(stmt)).all()]


# ─── resolution (review service, shoes service) ─────────────────────────────
async def brand_by_id(
    session: AsyncSession, brand_id: uuid.UUID
) -> CatalogBrand | None:
    return (
        await session.execute(
            select(CatalogBrand).where(
                CatalogBrand.id == brand_id, CatalogBrand.is_active.is_(True)
            )
        )
    ).scalar_one_or_none()


async def brand_by_name(session: AsyncSession, name: str | None) -> CatalogBrand | None:
    slug = slugify(name or "")
    if not slug:
        return None
    return (
        await session.execute(
            select(CatalogBrand).where(
                CatalogBrand.slug == slug, CatalogBrand.is_active.is_(True)
            )
        )
    ).scalar_one_or_none()


async def brands_by_names(
    session: AsyncSession, names: Iterable[str | None]
) -> dict[str, CatalogBrand]:
    slugs = sorted({slugify(n or "") for n in names} - {""})
    if not slugs:
        return {}
    rows = (
        await session.execute(
            select(CatalogBrand).where(
                CatalogBrand.slug.in_(slugs), CatalogBrand.is_active.is_(True)
            )
        )
    ).scalars()
    return {r.slug: r for r in rows}


async def size_by_id(
    session: AsyncSession, size_id: uuid.UUID, brand_id: uuid.UUID | None
) -> CatalogSize | None:
    size = await session.get(CatalogSize, size_id)
    if size is None:
        return None
    if size.brand_id is not None and size.brand_id != brand_id:
        return None
    return size


async def shoe_type_by_id(
    session: AsyncSession, type_id: uuid.UUID
) -> CatalogShoeType | None:
    return (
        await session.execute(
            select(CatalogShoeType).where(
                CatalogShoeType.id == type_id, CatalogShoeType.is_active.is_(True)
            )
        )
    ).scalar_one_or_none()


async def shoe_type_for_category(
    session: AsyncSession, category: str | None
) -> CatalogShoeType | None:
    slug = slugify(category or "")
    if not slug:
        return None
    mapped = (
        await session.execute(
            select(CatalogShoeType)
            .join(CatalogCategory, CatalogCategory.shoe_type_id == CatalogShoeType.id)
            .where(CatalogCategory.slug == slug, CatalogCategory.is_active.is_(True))
        )
    ).scalar_one_or_none()
    if mapped is not None and mapped.is_active:
        return mapped
    by_slug = shoe_type_for(slug)
    if not by_slug:
        return None
    return (
        await session.execute(
            select(CatalogShoeType).where(
                CatalogShoeType.slug == by_slug, CatalogShoeType.is_active.is_(True)
            )
        )
    ).scalar_one_or_none()


async def condition_mappings(session: AsyncSession) -> list[ConditionMapping]:
    return list(
        (
            await session.execute(
                select(ConditionMapping).order_by(ConditionMapping.sort_order.asc())
            )
        ).scalars()
    )


async def match_product(
    session: AsyncSession,
    brand_id: uuid.UUID | None,
    model: str | None,
    colour: str | None,
    size: str | None,
) -> CatalogProduct | None:
    """Silent SKU match: brand + model required; colour and size must give at
    least one point; msrp only breaks ties."""
    if brand_id is None or not model:
        return None
    p = CatalogProduct
    candidates = list(
        (
            await session.execute(
                select(p)
                .where(p.brand_id == brand_id, p.is_active.is_(True))
                .where(func.lower(p.model) == func.lower(model.strip()))
                .order_by(p.sku.asc())
                .limit(200)
            )
        ).scalars()
    )
    if not candidates:
        return None
    c = (colour or "").strip().lower()
    s = (size or "").strip()
    best: CatalogProduct | None = None
    best_score = -1.0
    for prod in candidates:
        score = 0.0
        if c and prod.colour and c in prod.colour.lower():
            score += 2
        if s and prod.size == s:
            score += 1
        if score == 0:
            continue
        if prod.msrp is not None:
            score += 0.5
        if score > best_score:
            best, best_score = prod, score
    return best


def product_summary(p: CatalogProduct) -> dict[str, Any]:
    return {"id": str(p.id), "sku": p.sku, "msrp": p.msrp}


async def preview_products(
    session: AsyncSession, limit: int = 10
) -> list[tuple[CatalogProduct, str]]:
    stmt = (
        select(CatalogProduct, CatalogBrand.name)
        .join(CatalogBrand, CatalogProduct.brand_id == CatalogBrand.id)
        .where(CatalogProduct.is_active.is_(True))
        .order_by(CatalogProduct.imported_at.desc())
        .limit(limit)
    )
    result = await session.execute(stmt)
    return [(row[0], row[1]) for row in result.all()]

