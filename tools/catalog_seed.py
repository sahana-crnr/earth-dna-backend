"""Catalog seed (port of scripts/catalog-seed.ts): reads the footwear taxonomy and
the product export from the product database (CATALOG_SOURCE_DB_*, read only)
and upserts them into this backend's catalog tables. Re-runnable: categories,
sub-categories, brands, products and sizes missing from the source are
deactivated, never deleted, so ids never change; only the brand/sub-category
link rows (no ids, nothing references them) are rebuilt. An empty source
export is refused rather than deactivating the whole catalog.

    uv run python -m tools.catalog_seed            # taxonomy + products + sizes
    uv run python -m tools.catalog_seed --dry      # read + plan, write nothing

The API never opens the source connection; only this script does.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
import sys
import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, insert, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.db import make_engine
from app.core.logging import configure_logging
from app.core.settings import Settings, get_settings
from app.models.catalog import (
    CatalogBrand,
    CatalogBrandSubcategory,
    CatalogCategory,
    CatalogProduct,
    CatalogShoeType,
    CatalogSize,
    CatalogSubcategory,
)
from app.services.catalog_rules import (
    generic_us_sizes,
    import_products,
    import_taxonomy,
    shoe_type_for,
    sizes_by_brand,
    title_case,
)

log = logging.getLogger("tools.catalog_seed")

DRY = "--dry" in sys.argv
PAGE = 1000
SOURCE_TAG = "import"
SOURCE_STATEMENT_TIMEOUT_MS = 120_000
PRODUCT_UPDATE_COLUMNS = [
    c
    for c in CatalogProduct.__table__.c
    if c.key
    in {
        "brandId",
        "model",
        "modelCode",
        "category",
        "subCategory",
        "silhouette",
        "gender",
        "colour",
        "size",
        "sizeRaw",
        "msrp",
        "releaseDate",
        "title",
        "source",
        "isActive",
        "importedAt",
    }
]


def taxonomy_sql(schema: str) -> str:
    # schema comes from settings (operator-controlled), quoted as an identifier
    return (
        f'SELECT category, subcategory, brand FROM "{schema}"."tracker" '  # noqa: S608
        "WHERE brand IS NOT NULL AND brand <> ''"
    )


def products_sql(schema: str) -> str:
    # keyset paging on sku_id: OFFSET paging re-sorted the whole table per page
    return (
        'SELECT sku_id AS sku, brand_s3 AS brand, model, model_code AS "modelCode", '  # noqa: S608
        'category, sub_category AS "subCategory", silhouette, gender, '
        "colour_raw AS colour, size, msrp_original AS msrp, "
        'listed_date::text AS "releaseDate", title '
        f'FROM "{schema}"."products" '
        "WHERE sku_id IS NOT NULL AND brand_s3 IS NOT NULL AND brand_s3 <> '' "
        "AND sku_id > :last ORDER BY sku_id LIMIT :page"
    )


def source_engine(settings: Settings) -> Any:
    s = settings
    if not (
        s.CATALOG_SOURCE_DB_HOST
        and s.CATALOG_SOURCE_DB_USERNAME
        and s.CATALOG_SOURCE_DB_PASSWORD is not None
        and s.CATALOG_SOURCE_DB_NAME
        and s.CATALOG_SOURCE_DB_SCHEMA
    ):
        raise SystemExit(
            "CATALOG_SOURCE_DB_HOST / PORT / USERNAME / PASSWORD / NAME / SCHEMA must all be set"
        )
    url = URL.create(
        "postgresql+asyncpg",
        username=s.CATALOG_SOURCE_DB_USERNAME,
        password=s.CATALOG_SOURCE_DB_PASSWORD,
        host=s.CATALOG_SOURCE_DB_HOST,
        port=s.CATALOG_SOURCE_DB_PORT,
        database=s.CATALOG_SOURCE_DB_NAME,
    )
    connect_args: dict[str, Any] = {
        "server_settings": {"statement_timeout": str(SOURCE_STATEMENT_TIMEOUT_MS)}
    }
    if s.CATALOG_SOURCE_DB_SSL:
        # Encrypted, not verified: the product RDS presents the regional RDS CA,
        # which is not in the system store (the Node script used
        # rejectUnauthorized: false for the same reason).
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        connect_args["ssl"] = ctx
    return create_async_engine(url, connect_args=connect_args, pool_pre_ping=True)


async def upsert_by_slug(
    session: AsyncSession, model: Any, slug: str, values: dict[str, Any]
) -> uuid.UUID:
    existing = (
        await session.execute(select(model.id).where(model.slug == slug))
    ).scalar_one_or_none()
    if existing is not None:
        await session.execute(
            update(model).where(model.id == existing).values(**values)
        )
        return uuid.UUID(str(existing))
    row = model(slug=slug, **values)
    session.add(row)
    await session.flush()
    return uuid.UUID(str(row.id))


async def deactivate_missing(
    session: AsyncSession, model: Any, keep_slugs: list[str]
) -> None:
    stmt = update(model).values(is_active=False)
    if keep_slugs:
        stmt = stmt.where(model.slug.not_in(keep_slugs))
    await session.execute(stmt)


async def main() -> int:
    configure_logging("INFO")
    settings = get_settings()
    assert settings.CATALOG_SOURCE_DB_SCHEMA
    schema = settings.CATALOG_SOURCE_DB_SCHEMA
    source = source_engine(settings)
    target = make_engine(settings)
    try:
        async with source.connect() as conn:
            taxonomy_rows = [
                dict(r._mapping)
                for r in (await conn.execute(text(taxonomy_sql(schema)))).all()
            ]
            if not taxonomy_rows:
                raise SystemExit(
                    "source taxonomy table returned no rows — refusing to deactivate the whole catalog"
                )
            plan = import_taxonomy(taxonomy_rows)
            print(
                f"taxonomy: {len(taxonomy_rows)} rows → {len(plan.categories)} categories, "
                f"{len(plan.subcategories)} sub-categories, {len(plan.brands)} brands, "
                f"{len(plan.links)} links, {plan.skipped} skipped"
            )
            product_rows: list[dict[str, Any]] = []
            last = ""
            while True:
                page = [
                    dict(r._mapping)
                    for r in (
                        await conn.execute(
                            text(products_sql(schema)), {"last": last, "page": PAGE}
                        )
                    ).all()
                ]
                product_rows.extend(page)
                if page:
                    last = str(page[-1]["sku"])
                    print(f"products: read {len(product_rows)}…", end="\r", flush=True)
                if len(page) < PAGE:
                    break
            print()
        products, products_skipped = import_products(product_rows)
        if not products:
            raise SystemExit(
                "source products returned no usable rows — "
                "refusing to deactivate the whole catalog"
            )
        taxonomy_slugs = {b["slug"] for b in plan.brands}
        extra_brands = sorted({p["brandSlug"] for p in products} - taxonomy_slugs)
        per_brand_sizes = sizes_by_brand(products)
        print(
            f"products: {len(product_rows)} rows → {len(products)} upserts, {products_skipped} skipped, "
            f"{len(extra_brands)} brands not in taxonomy, {len(per_brand_sizes)} brands with sizes"
        )
        if DRY:
            print("dry run — nothing written")
            return 0

        async with AsyncSession(target, expire_on_commit=False) as session:
            now_rows = (await session.execute(text("SELECT now()"))).scalar_one()
            shoe_type_ids = {
                t.slug: t.id
                for t in (await session.execute(select(CatalogShoeType))).scalars()
            }
            cat_ids: dict[str, uuid.UUID] = {}
            for i, c in enumerate(plan.categories):
                type_slug = shoe_type_for(c["slug"]) or shoe_type_for(c["name"])
                cat_ids[c["slug"]] = await upsert_by_slug(
                    session,
                    CatalogCategory,
                    c["slug"],
                    {
                        "name": c["name"],
                        "sort_order": i,
                        "is_active": True,
                        "shoe_type_id": shoe_type_ids.get(type_slug)
                        if type_slug
                        else None,
                    },
                )
            await deactivate_missing(session, CatalogCategory, list(cat_ids))

            sub_ids: dict[str, uuid.UUID] = {}
            for i, s in enumerate(plan.subcategories):
                category_id = cat_ids[s["categorySlug"]]
                existing = (
                    await session.execute(
                        select(CatalogSubcategory.id).where(
                            CatalogSubcategory.category_id == category_id,
                            CatalogSubcategory.slug == s["slug"],
                        )
                    )
                ).scalar_one_or_none()
                if existing is not None:
                    await session.execute(
                        update(CatalogSubcategory)
                        .where(CatalogSubcategory.id == existing)
                        .values(name=s["name"], sort_order=i, is_active=True)
                    )
                    sub_id = existing
                else:
                    row = CatalogSubcategory(
                        category_id=category_id,
                        slug=s["slug"],
                        name=s["name"],
                        sort_order=i,
                        is_active=True,
                    )
                    session.add(row)
                    await session.flush()
                    sub_id = row.id
                sub_ids[f"{s['categorySlug']}/{s['slug']}"] = sub_id
            stmt_sub = update(CatalogSubcategory).values(is_active=False)
            if sub_ids:
                stmt_sub = stmt_sub.where(
                    CatalogSubcategory.id.not_in(list(sub_ids.values()))
                )
            await session.execute(stmt_sub)

            brand_ids: dict[str, uuid.UUID] = {}
            all_brands = [
                *plan.brands,
                *({"slug": s, "name": title_case(s)} for s in extra_brands),
            ]
            for i, b in enumerate(all_brands):
                brand_ids[b["slug"]] = await upsert_by_slug(
                    session,
                    CatalogBrand,
                    b["slug"],
                    {"name": b["name"], "sort_order": i, "is_active": True},
                )
            await deactivate_missing(session, CatalogBrand, list(brand_ids))

            await session.execute(delete(CatalogBrandSubcategory))
            links = [
                {
                    "brand_id": brand_ids[link["brandSlug"]],
                    "subcategory_id": sub_ids[
                        f"{link['categorySlug']}/{link['subcategorySlug']}"
                    ],
                }
                for link in plan.links
                if link["brandSlug"] in brand_ids
                and f"{link['categorySlug']}/{link['subcategorySlug']}" in sub_ids
            ]
            for i in range(0, len(links), PAGE):
                await session.execute(
                    insert(CatalogBrandSubcategory), links[i : i + PAGE]
                )

            skus: set[str] = set()
            for i in range(0, len(products), PAGE):
                chunk = [
                    {
                        "sku": p["sku"],
                        "brand_id": brand_ids[p["brandSlug"]],
                        "model": p["model"],
                        "model_code": p["modelCode"],
                        "category": p["category"],
                        "sub_category": p["subCategory"],
                        "silhouette": p["silhouette"],
                        "gender": p["gender"],
                        "colour": p["colour"],
                        "size": p["size"],
                        "size_raw": p["sizeRaw"],
                        "msrp": Decimal(str(p["msrp"]))
                        if p["msrp"] is not None
                        else None,
                        "release_date": date.fromisoformat(p["releaseDate"])
                        if p["releaseDate"]
                        else None,
                        "title": p["title"],
                        "source": SOURCE_TAG,
                        "is_active": True,
                        "imported_at": now_rows,
                    }
                    for p in products[i : i + PAGE]
                ]
                stmt = pg_insert(CatalogProduct).values(chunk)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["sku"],
                    set_={c: stmt.excluded[c.key] for c in PRODUCT_UPDATE_COLUMNS},
                )
                await session.execute(stmt)
                skus.update(p["sku"] for p in products[i : i + PAGE])
            await session.execute(
                update(CatalogProduct)
                .where(CatalogProduct.imported_at < now_rows)
                .values(is_active=False)
            )

            size_rows = 0
            for slug, labels in per_brand_sizes.items():
                brand_id = brand_ids.get(slug)
                if brand_id is None:
                    continue
                have = {
                    r[0]
                    for r in (
                        await session.execute(
                            select(CatalogSize.label).where(
                                CatalogSize.brand_id == brand_id,
                                CatalogSize.system == "US",
                            )
                        )
                    ).all()
                }
                missing = [
                    {
                        "brand_id": brand_id,
                        "system": "US",
                        "label": label,
                        "sort_order": idx,
                    }
                    for idx, label in enumerate(labels)
                    if label not in have
                ]
                if missing:
                    await session.execute(insert(CatalogSize), missing)
                size_rows += len(missing)
            have_generic = {
                r[0]
                for r in (
                    await session.execute(
                        select(CatalogSize.label).where(
                            CatalogSize.brand_id.is_(None), CatalogSize.system == "US"
                        )
                    )
                ).all()
            }
            missing_generic = [
                {"brand_id": None, "system": "US", "label": label, "sort_order": i}
                for i, label in enumerate(generic_us_sizes())
                if label not in have_generic
            ]
            if missing_generic:
                await session.execute(insert(CatalogSize), missing_generic)
            await session.commit()
            print(
                f"written: {len(cat_ids)} categories, {len(sub_ids)} sub-categories, {len(brand_ids)} brands, "
                f"{len(links)} links, {len(skus)} products, {size_rows} new brand sizes, generic sizes +{len(missing_generic)}"
            )
        return 0
    finally:
        await source.dispose()
        await target.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
