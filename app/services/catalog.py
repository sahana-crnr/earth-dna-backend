"""F3 catalog list views (E14 to E19). Plain reads, every list capped by
CATALOG_LIST_MAX, active rows only."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import GENDERS
from app.core.settings import Settings
from app.repositories import catalog as repo
from app.services.catalog_rules import locale_key, size_sort_key


class CatalogService:
    def __init__(self, settings: Settings) -> None:
        self._max = settings.CATALOG_LIST_MAX

    async def list_brands(self, session: AsyncSession, q: str | None) -> dict[str, Any]:
        rows = await repo.brands(session, q, self._max)
        return {
            "items": [{"id": str(b.id), "name": b.name, "slug": b.slug} for b in rows]
        }

    async def list_sizes(
        self, session: AsyncSession, brand_id: uuid.UUID | None
    ) -> dict[str, Any]:
        rows = []
        if brand_id is not None:
            rows = await repo.sizes_for_brand(session, brand_id, self._max)
        if not rows:
            rows = await repo.sizes_for_brand(session, None, self._max)
        rows.sort(key=lambda s: (size_sort_key(s.label), locale_key(s.label)))
        return {
            "items": [
                {"id": str(s.id), "label": s.label, "system": s.system} for s in rows
            ],
            "generic": len(rows) > 0 and rows[0].brand_id is None,
        }

    async def list_shoe_types(self, session: AsyncSession) -> dict[str, Any]:
        rows = await repo.shoe_types_with_categories(session)
        return {
            "items": [
                {
                    "id": str(t.id),
                    "name": t.name,
                    "slug": t.slug,
                    "categories": [
                        {"id": str(c.id), "name": c.name, "slug": c.slug}
                        for c in sorted(
                            (c for c in cats if c.is_active),
                            key=lambda c: (locale_key(c.name), locale_key(str(c.id))),
                        )
                    ],
                }
                for t, cats in rows
            ]
        }

    async def list_categories(self, session: AsyncSession) -> dict[str, Any]:
        rows = await repo.categories_with_subcategories(session, self._max)
        return {
            "items": [
                {
                    "id": str(c.id),
                    "name": c.name,
                    "slug": c.slug,
                    "subcategories": [
                        {"id": str(s.id), "name": s.name, "slug": s.slug}
                        for s in sorted(
                            (s for s in subs if s.is_active),
                            key=lambda s: (locale_key(s.name), locale_key(str(s.id))),
                        )
                    ],
                }
                for c, subs in rows
            ]
        }

    async def list_models(
        self, session: AsyncSession, brand_id: uuid.UUID, q: str | None
    ) -> dict[str, Any]:
        rows = await repo.models(session, brand_id, q, self._max)
        return {"items": [{"model": m, "modelCode": code} for m, code in rows]}

    async def list_colours(
        self, session: AsyncSession, brand_id: uuid.UUID, model: str | None
    ) -> dict[str, Any]:
        rows = await repo.colours(session, brand_id, model, self._max)
        return {"items": [{"colour": c} for c in rows]}

    def options(self) -> dict[str, Any]:
        return {"genders": list(GENDERS)}
