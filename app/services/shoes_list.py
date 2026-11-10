"""E31 list and E32 summary (src/shoes/shoes-list.service.ts)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.shoe import Shoe
from app.repositories import shoes as repo
from app.services.shoe_rules import codes_for_conditions, to_summary
from app.services.shoe_views import ShoeViewMapper


class ShoesListService:
    def __init__(self, views: ShoeViewMapper) -> None:
        self._views = views

    async def list(
        self, session: AsyncSession, user_id: uuid.UUID, q: dict[str, Any]
    ) -> dict[str, Any]:
        limit = int(q.get("limit") or 20)
        offset = int(q.get("offset") or 0)
        base = select(Shoe).where(Shoe.user_id == user_id, Shoe.deleted_at.is_(None))
        if q.get("actionTaken"):
            base = base.where(Shoe.action_taken.in_(q["actionTaken"]))
        if q.get("condition"):
            base = base.where(
                Shoe.condition_code.in_(codes_for_conditions(q["condition"]))
            )
        if q.get("recommendedAction"):
            base = base.where(Shoe.recommended_action.in_(q["recommendedAction"]))
        if q.get("resaleBucket"):
            base = base.where(Shoe.resale_bucket.in_(q["resaleBucket"]))
        rows = list(
            (
                await session.execute(
                    base.order_by(Shoe.created_at.desc(), Shoe.id.desc())
                    .limit(limit)
                    .offset(offset)
                )
            ).scalars()
        )
        total = int(
            (
                await session.execute(select(func.count()).select_from(base.subquery()))
            ).scalar_one()
        )
        keys = await repo.primary_keys_for(session, rows)
        labels = await repo.condition_labels(session)
        items = []
        for e in rows:
            view = await self._views.to_my_shoe_view(
                e, keys.get(e.primary_photo_id) if e.primary_photo_id else None, labels
            )
            view["actionTaken"] = e.action_taken
            view["resaleBucket"] = e.resale_bucket
            items.append(view)
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    async def summary(
        self, session: AsyncSession, user_id: uuid.UUID
    ) -> dict[str, Any]:
        open_ = (
            (Shoe.action_taken == "none")
            & Shoe.resale_min.is_not(None)
            & Shoe.resale_max.is_not(None)
        )
        row = (
            await session.execute(
                select(
                    func.count(),
                    func.count().filter(open_),
                    func.sum(Shoe.resale_min).filter(open_),
                    func.sum(Shoe.resale_max).filter(open_),
                ).where(Shoe.user_id == user_id, Shoe.deleted_at.is_(None))
            )
        ).one()
        return to_summary(row[0], row[1], row[2], row[3])
