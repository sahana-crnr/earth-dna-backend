"""My Shoes reads shared by the review, results and shoes services."""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.models.catalog import ConditionMapping
from app.models.shoe import Shoe, ShoeFeedback, ShoePhoto, ShoeShare


def not_found(code: str, message: str) -> ApiError:
    return ApiError(404, code, message)


async def find_owned_shoe(
    session: AsyncSession, user_id: uuid.UUID, shoe_id: uuid.UUID, lock: bool = False
) -> Shoe:
    stmt = select(Shoe).where(
        Shoe.id == shoe_id, Shoe.user_id == user_id, Shoe.deleted_at.is_(None)
    )
    if lock:
        stmt = stmt.with_for_update()
    shoe = (await session.execute(stmt)).scalar_one_or_none()
    if shoe is None:
        raise not_found("SHOE_NOT_FOUND", "Shoe not found")
    return shoe


async def photos_of(session: AsyncSession, shoe_id: uuid.UUID) -> list[ShoePhoto]:
    return list(
        (
            await session.execute(
                select(ShoePhoto)
                .where(ShoePhoto.shoe_id == shoe_id)
                .order_by(
                    ShoePhoto.sort_order.asc(),
                    ShoePhoto.created_at.asc(),
                    ShoePhoto.id.asc(),
                )
            )
        ).scalars()
    )


async def active_share(session: AsyncSession, shoe_id: uuid.UUID) -> ShoeShare | None:
    return (
        await session.execute(
            select(ShoeShare).where(
                ShoeShare.shoe_id == shoe_id, ShoeShare.revoked_at.is_(None)
            )
        )
    ).scalar_one_or_none()


async def latest_condition_feedback(
    session: AsyncSession, shoe_id: uuid.UUID
) -> ShoeFeedback | None:
    return (
        await session.execute(
            select(ShoeFeedback)
            .where(
                ShoeFeedback.shoe_id == shoe_id,
                ShoeFeedback.type == "condition_suggested",
            )
            .order_by(ShoeFeedback.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def entries_for_scan_shoes(
    session: AsyncSession, scan_shoe_ids: Sequence[uuid.UUID]
) -> list[Shoe]:
    if not scan_shoe_ids:
        return []
    return list(
        (
            await session.execute(
                select(Shoe).where(Shoe.scan_shoe_id.in_(list(scan_shoe_ids)))
            )
        ).scalars()
    )


async def primary_keys_for(
    session: AsyncSession, entries: Sequence[Shoe]
) -> dict[uuid.UUID, str]:
    ids = [e.primary_photo_id for e in entries if e.primary_photo_id is not None]
    if not ids:
        return {}
    rows = await session.execute(
        select(ShoePhoto.id, ShoePhoto.s3_key).where(ShoePhoto.id.in_(ids))
    )
    return {r[0]: str(r[1]) for r in rows.all()}


async def condition_labels(session: AsyncSession) -> dict[str, str]:
    rows = await session.execute(select(ConditionMapping.code, ConditionMapping.label))
    return {str(r[0]): str(r[1]) for r in rows.all()}
