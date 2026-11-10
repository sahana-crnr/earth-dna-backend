"""Scan session reads and the small write helpers (src/scan/scan-access.ts)."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.models.scan import Scan, ScanPhoto, ScanShoe


def not_found(code: str, message: str) -> ApiError:
    return ApiError(404, code, message)


@dataclass
class ShoeWithPhotos:
    shoe: ScanShoe
    photos: list[ScanPhoto] = field(default_factory=list)

    @property
    def id(self) -> uuid.UUID:
        return self.shoe.id

    @property
    def position(self) -> int:
        return self.shoe.position

    @property
    def views(self) -> list[str]:
        return [p.view for p in self.photos]


async def find_owned_scan(
    session: AsyncSession, user_id: uuid.UUID, scan_id: uuid.UUID, lock: bool = False
) -> Scan:
    stmt = select(Scan).where(Scan.id == scan_id, Scan.user_id == user_id)
    if lock:
        stmt = stmt.with_for_update()
    scan = (await session.execute(stmt)).scalar_one_or_none()
    if scan is None:
        raise not_found("SCAN_NOT_FOUND", "Scan not found")
    return scan


async def load_shoes(
    session: AsyncSession, scan_ids: Sequence[uuid.UUID]
) -> list[ShoeWithPhotos]:
    if not scan_ids:
        return []
    shoes = list(
        (
            await session.execute(
                select(ScanShoe)
                .where(ScanShoe.scan_id.in_(list(scan_ids)))
                .order_by(ScanShoe.position.asc())
            )
        ).scalars()
    )
    if not shoes:
        return []
    photos = list(
        (
            await session.execute(
                select(ScanPhoto).where(
                    ScanPhoto.scan_shoe_id.in_([s.id for s in shoes])
                )
            )
        ).scalars()
    )
    by_shoe: dict[uuid.UUID, list[ScanPhoto]] = {s.id: [] for s in shoes}
    for p in photos:
        by_shoe[p.scan_shoe_id].append(p)
    return [ShoeWithPhotos(shoe=s, photos=by_shoe[s.id]) for s in shoes]


async def touch_scan(session: AsyncSession, scan_id: uuid.UUID) -> None:
    await session.execute(
        update(Scan).where(Scan.id == scan_id).values(updated_at=func.now())
    )


async def assert_draft_room(
    session: AsyncSession, user_id: uuid.UUID, max_open: int
) -> None:
    if max_open <= 0:
        return
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
        {"k": f"scan-draft:{user_id}"},
    )
    open_count = (
        await session.execute(
            select(func.count())
            .select_from(Scan)
            .where(Scan.user_id == user_id, Scan.status == "draft")
        )
    ).scalar_one()
    if open_count >= max_open:
        raise ApiError(
            409, "DRAFT_LIMIT_REACHED", f"You can have at most {max_open} open scans"
        )


async def count_shoes(session: AsyncSession, scan_id: uuid.UUID) -> int:
    return int(
        (
            await session.execute(
                select(func.count())
                .select_from(ScanShoe)
                .where(ScanShoe.scan_id == scan_id)
            )
        ).scalar_one()
    )


async def shoe_in_scan(
    session: AsyncSession, shoe_id: uuid.UUID, scan_id: uuid.UUID
) -> ScanShoe | None:
    return (
        await session.execute(
            select(ScanShoe).where(ScanShoe.id == shoe_id, ScanShoe.scan_id == scan_id)
        )
    ).scalar_one_or_none()


async def photo_for_view(
    session: AsyncSession, shoe_id: uuid.UUID, view: str
) -> ScanPhoto | None:
    return (
        await session.execute(
            select(ScanPhoto).where(
                ScanPhoto.scan_shoe_id == shoe_id, ScanPhoto.view == view
            )
        )
    ).scalar_one_or_none()


async def photo_views(session: AsyncSession, shoe_id: uuid.UUID) -> list[str]:
    rows = await session.execute(
        select(ScanPhoto.view).where(ScanPhoto.scan_shoe_id == shoe_id)
    )
    return [str(r[0]) for r in rows.all()]


async def photos_of_scan(session: AsyncSession, scan_id: uuid.UUID) -> list[ScanPhoto]:
    return list(
        (
            await session.execute(
                select(ScanPhoto)
                .join(ScanShoe, ScanShoe.id == ScanPhoto.scan_shoe_id)
                .where(ScanShoe.scan_id == scan_id)
            )
        ).scalars()
    )
