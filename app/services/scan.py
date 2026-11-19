"""F1 scan sessions (src/scan/scan.service.ts): drafts, shoes, photo uploads,
album batches, finish, abandon, purge.

Every mutation runs inside one transaction that locks the scan row, asserts it
is still a draft, does the work, bumps `updatedAt`, re-reads the session for
the response and commits; object deletes happen after the commit.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import ApiError
from app.core.settings import Settings
from app.core.time import to_js_iso, utcnow
from app.models.scan import Scan, ScanPhoto, ScanShoe
from app.repositories import scans as repo
from app.repositories.scans import ShoeWithPhotos, not_found
from app.services.scan_rules import (
    CONTENT_TYPE,
    Decision,
    FileInfo,
    Limits,
    ManifestShoe,
    ShoeViews,
    compute_shoe_state,
    incomplete_shoes,
    label_for,
    order_by_position,
    renumber,
    scan_photo_key,
    sniff_image_type,
    view_index,
)
from app.services.storage import (
    PhotoStorage,
    put_or_throw,
    require_storage,
    safe_delete,
    sign_or_null,
    validate_uploaded_photo,
)

log = logging.getLogger("app.scan")


@dataclass
class UploadedPart:
    fieldname: str
    data: bytes

    @property
    def size(self) -> int:
        return len(self.data)


@dataclass
class TxResult:
    after_commit_deletes: list[str] = field(default_factory=list)


def assert_draft(scan: Scan) -> None:
    if scan.status != "draft":
        raise ApiError(
            409, "NOT_DRAFT", f"Scan is {scan.status}; it can no longer be changed"
        )


class ScanService:
    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        storage: PhotoStorage,
        results: Any | None = None,
    ) -> None:
        self._s = settings
        self._sessions = session_factory
        self._storage = storage
        self._results = results
        self._limits = Limits(
            photo_max_bytes=settings.SCAN_PHOTO_MAX_BYTES,
            allowed_types=tuple(settings.SCAN_PHOTO_ALLOWED_TYPES),
        )

    # ─── E1 create ───────────────────────────────────────────────────────────
    async def create_draft(
        self, session: AsyncSession, user_id: uuid.UUID
    ) -> dict[str, Any]:
        require_storage(self._storage)
        await repo.assert_draft_room(session, user_id, self._s.SCAN_MAX_OPEN_DRAFTS)
        scan = Scan(user_id=user_id, status="draft", source="camera")
        session.add(scan)
        await session.flush()
        await session.refresh(scan)
        await session.commit()
        log.info("scan %s created", scan.id)
        return await self._build_session(scan, [])

    # ─── E2 list ─────────────────────────────────────────────────────────────
    async def list_scans(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        status: str | None,
        limit: int,
        offset: int,
    ) -> dict[str, Any]:
        base = select(Scan).where(Scan.user_id == user_id, Scan.hidden_at.is_(None))
        if status:
            base = base.where(Scan.status == status)
        rows = list(
            (
                await session.execute(
                    base.order_by(Scan.updated_at.desc(), Scan.id.desc())
                    .limit(limit)
                    .offset(offset)
                )
            ).scalars()
        )
        from sqlalchemy import func

        total = int(
            (
                await session.execute(select(func.count()).select_from(base.subquery()))
            ).scalar_one()
        )
        shoes = await repo.load_shoes(session, [r.id for r in rows]) if rows else []
        items = []
        for r in rows:
            mine = [s for s in shoes if s.shoe.scan_id == r.id]
            complete = sum(1 for s in mine if compute_shoe_state(s.views).complete)
            items.append(
                {
                    "id": str(r.id),
                    "status": r.status,
                    "source": r.source,
                    "createdAt": to_js_iso(r.created_at),
                    "updatedAt": to_js_iso(r.updated_at),
                    "finishedAt": to_js_iso(r.finished_at) if r.finished_at else None,
                    "shoeCount": len(mine),
                    "completeShoes": complete,
                    "canFinish": r.status == "draft"
                    and len(mine) > 0
                    and complete == len(mine),
                }
            )
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    # ─── E3 get ──────────────────────────────────────────────────────────────
    async def get(
        self, session: AsyncSession, user_id: uuid.UUID, scan_id: uuid.UUID
    ) -> dict[str, Any]:
        require_storage(self._storage)
        scan = await repo.find_owned_scan(session, user_id, scan_id)
        return await self._build_session(
            scan, await repo.load_shoes(session, [scan.id])
        )

    # ─── E4 add shoe ─────────────────────────────────────────────────────────
    async def add_shoe(
        self, session: AsyncSession, user_id: uuid.UUID, scan_id: uuid.UUID
    ) -> dict[str, Any]:
        require_storage(self._storage)

        async def work(s: AsyncSession, scan: Scan) -> TxResult:
            count = await repo.count_shoes(s, scan.id)
            if count >= self._s.SCAN_MAX_SHOES:
                raise ApiError(
                    409,
                    "SHOE_LIMIT_REACHED",
                    f"A scan can hold at most {self._s.SCAN_MAX_SHOES} shoes",
                )
            await s.execute(
                insert(ScanShoe).values(
                    scan_id=scan.id, position=count + 1, status="capturing"
                )
            )
            return TxResult()

        return await self._in_draft_tx(session, user_id, scan_id, work)

    # ─── E5 delete shoe ──────────────────────────────────────────────────────
    async def delete_shoe(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        shoe_id: uuid.UUID,
    ) -> dict[str, Any]:
        require_storage(self._storage)

        async def work(s: AsyncSession, scan: Scan) -> TxResult:
            shoes = await repo.load_shoes(s, [scan.id])
            target = next((x for x in shoes if x.id == shoe_id), None)
            if target is None:
                raise not_found("SHOE_NOT_FOUND", "Shoe not found")
            await s.execute(delete(ScanShoe).where(ScanShoe.id == target.id))
            remaining = order_by_position([x for x in shoes if x.id != shoe_id])
            for sid, position in renumber([x.id for x in remaining]).items():
                before = next(x for x in remaining if x.id == sid).position
                if before != position:
                    await s.execute(
                        update(ScanShoe)
                        .where(ScanShoe.id == sid)
                        .values(position=position)
                    )
            keys = (
                [p.s3_key for p in target.photos]
                if self._s.SCAN_DELETE_OBJECTS_ON_REMOVE
                else []
            )
            return TxResult(after_commit_deletes=keys)

        return await self._in_draft_tx(session, user_id, scan_id, work)

    # ─── E20 delete empty draft ──────────────────────────────────────────────
    async def delete_empty_draft(
        self, session: AsyncSession, user_id: uuid.UUID, scan_id: uuid.UUID
    ) -> None:
        scan = await repo.find_owned_scan(session, user_id, scan_id, lock=True)
        if scan.status != "abandoned":
            assert_draft(scan)
        shoes = await repo.count_shoes(session, scan.id)
        if shoes > 0:
            raise ApiError(
                409,
                "SCAN_NOT_EMPTY",
                f"Scan still has {shoes} shoe(s); remove them first",
                {"shoeCount": shoes},
            )
        await session.execute(delete(Scan).where(Scan.id == scan.id))
        await session.commit()
        log.info("scan %s deleted (empty draft)", scan_id)

    # ─── E6 upload / retake ──────────────────────────────────────────────────
    async def upload_photo(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        shoe_id: uuid.UUID,
        view: str,
        data: bytes | None,
        taken_at: datetime | None,
    ) -> dict[str, Any]:
        require_storage(self._storage)
        photo_type = validate_uploaded_photo(data, self._limits)
        assert data is not None
        scan = await repo.find_owned_scan(session, user_id, scan_id)
        assert_draft(scan)
        shoe = await repo.shoe_in_scan(session, shoe_id, scan.id)
        if shoe is None:
            raise not_found("SHOE_NOT_FOUND", "Shoe not found")
        scan_pk, shoe_pk = scan.id, shoe.id
        # release the read transaction before the slow upload (expires the rows)
        await session.rollback()
        key = scan_photo_key(
            str(scan_pk), str(shoe_pk), view, photo_type, str(uuid.uuid4())
        )
        await put_or_throw(self._storage, key, data, CONTENT_TYPE[photo_type])
        size = len(data)

        async def work(s: AsyncSession, locked: Scan) -> TxResult:
            still = await repo.shoe_in_scan(s, shoe_pk, locked.id)
            if still is None:
                raise not_found("SHOE_NOT_FOUND", "Shoe not found")
            existing = await repo.photo_for_view(s, shoe_pk, view)
            # the ORM UPDATE below synchronises `existing` in place; keep the old key
            old_key = existing.s3_key if existing is not None else None
            fields: dict[str, Any] = {
                "s3_key": key,
                "content_type": CONTENT_TYPE[photo_type],
                "bytes": size,
                "taken_at": taken_at,
                "upload_status": "uploaded",
                "width": None,
                "height": None,
            }
            if existing is not None:
                await s.execute(
                    update(ScanPhoto)
                    .where(ScanPhoto.id == existing.id)
                    .values(**fields)
                )
            else:
                await s.execute(
                    insert(ScanPhoto).values(scan_shoe_id=shoe_pk, view=view, **fields)
                )
            await self._refresh_shoe_status(s, shoe_pk)
            return TxResult(after_commit_deletes=[old_key] if old_key else [])

        try:
            return await self._in_draft_tx(session, user_id, scan_id, work)
        except Exception:
            await safe_delete(self._storage, key)
            raise

    # ─── E7 delete photo ─────────────────────────────────────────────────────
    async def delete_photo(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        shoe_id: uuid.UUID,
        view: str,
    ) -> dict[str, Any]:
        require_storage(self._storage)

        async def work(s: AsyncSession, scan: Scan) -> TxResult:
            shoe = await repo.shoe_in_scan(s, shoe_id, scan.id)
            if shoe is None:
                raise not_found("SHOE_NOT_FOUND", "Shoe not found")
            photo = await repo.photo_for_view(s, shoe.id, view)
            if photo is None:
                raise not_found("PHOTO_NOT_FOUND", f"No '{view}' photo for this shoe")
            await s.execute(delete(ScanPhoto).where(ScanPhoto.id == photo.id))
            await self._refresh_shoe_status(s, shoe.id)
            keys = [photo.s3_key] if self._s.SCAN_DELETE_OBJECTS_ON_REMOVE else []
            return TxResult(after_commit_deletes=keys)

        return await self._in_draft_tx(session, user_id, scan_id, work)

    # ─── E8 album batch ──────────────────────────────────────────────────────
    async def album_batch(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        manifest: list[ManifestShoe],
        files: list[UploadedPart],
    ) -> dict[str, Any]:
        require_storage(self._storage)
        refs = sum(len(s.files) for s in manifest)
        if (
            len(manifest) > self._s.SCAN_ALBUM_MAX_SHOES
            or refs > self._s.SCAN_ALBUM_MAX_PHOTOS
            or len(files) > self._s.SCAN_ALBUM_MAX_PHOTOS
        ):
            raise ApiError(
                413,
                "BATCH_TOO_LARGE",
                f"An album upload can hold at most {self._s.SCAN_ALBUM_MAX_SHOES} shoes "
                f"and {self._s.SCAN_ALBUM_MAX_PHOTOS} photos",
            )
        by_field: dict[str, UploadedPart] = {}
        for part_in in files:
            if part_in.fieldname in by_field:
                raise ApiError(
                    400,
                    "DUPLICATE_FILE_FIELD",
                    f"File part '{part_in.fieldname}' was sent twice",
                )
            by_field[part_in.fieldname] = part_in
        info = {
            k: FileInfo(size=p.size, type=sniff_image_type(p.data))
            for k, p in by_field.items()
        }

        scan = await repo.find_owned_scan(session, user_id, scan_id)
        assert_draft(scan)
        scan_pk = scan.id
        current = await repo.count_shoes(session, scan_pk)
        await session.rollback()
        from app.services.scan_rules import decide_album_shoes

        decisions: list[Decision] = decide_album_shoes(
            manifest, info, self._limits, self._s.SCAN_MAX_SHOES - current
        )

        @dataclass
        class StagedFile:
            view: str
            type: str
            key: str
            bytes: int

        @dataclass
        class Staged:
            ref: str
            shoe_id: uuid.UUID
            files: list[StagedFile]

        results: list[dict[str, Any]] = []
        staged: list[Staged] = []
        uploaded: list[str] = []
        for d in decisions:
            if not d.accepted:
                results.append(
                    {"ref": d.ref, "saved": False, "error": d.error, "detail": d.detail}
                )
                continue
            shoe_id = uuid.uuid4()
            entry = Staged(ref=d.ref, shoe_id=shoe_id, files=[])
            try:
                for f in d.files:
                    key = scan_photo_key(
                        str(scan_pk), str(shoe_id), f.view, f.type, str(uuid.uuid4())
                    )
                    part = by_field[f.field]
                    await self._storage.put(key, part.data, CONTENT_TYPE[f.type])
                    uploaded.append(key)
                    entry.files.append(
                        StagedFile(view=f.view, type=f.type, key=key, bytes=part.size)
                    )
                staged.append(entry)
            except Exception as exc:
                log.error("album shoe %s upload failed: %s", d.ref, exc)
                for sf in entry.files:
                    await safe_delete(self._storage, sf.key)
                results.append(
                    {
                        "ref": d.ref,
                        "saved": False,
                        "error": "STORAGE_UNAVAILABLE",
                        "detail": "photo storage failed, try again",
                    }
                )

        async def work(s: AsyncSession, locked: Scan) -> TxResult:
            position = await repo.count_shoes(s, locked.id)
            drop: list[str] = []
            for st in staged:
                if position >= self._s.SCAN_MAX_SHOES:
                    drop.extend(f.key for f in st.files)
                    results.append(
                        {
                            "ref": st.ref,
                            "saved": False,
                            "error": "SHOE_LIMIT_REACHED",
                            "detail": "session is full",
                        }
                    )
                    continue
                position += 1
                await s.execute(
                    insert(ScanShoe).values(
                        id=st.shoe_id,
                        scan_id=locked.id,
                        position=position,
                        status="capturing",
                    )
                )
                await s.execute(
                    insert(ScanPhoto),
                    [
                        {
                            "scan_shoe_id": st.shoe_id,
                            "view": f.view,
                            "s3_key": f.key,
                            "content_type": CONTENT_TYPE[f.type],
                            "bytes": f.bytes,
                            "upload_status": "uploaded",
                        }
                        for f in st.files
                    ],
                )
                await self._refresh_shoe_status(s, st.shoe_id)
                state = compute_shoe_state([f.view for f in st.files])
                results.append(
                    {
                        "ref": st.ref,
                        "saved": True,
                        "shoeId": str(st.shoe_id),
                        "label": label_for(position),
                        "complete": state.complete,
                        "missing": state.missing,
                    }
                )
            if any(r["saved"] for r in results):
                await s.execute(
                    update(Scan).where(Scan.id == locked.id).values(source="album")
                )
            return TxResult(after_commit_deletes=drop)

        try:
            session_view = await self._in_draft_tx(session, user_id, scan_id, work)
        except Exception:
            for k in uploaded:
                await safe_delete(self._storage, k)
            raise
        order = {s.ref: i for i, s in enumerate(manifest)}
        results.sort(key=lambda r: order.get(str(r["ref"]), 0))
        return {"session": session_view, "results": results}

    # ─── E9 finish ───────────────────────────────────────────────────────────
    async def finish(
        self, session: AsyncSession, user_id: uuid.UUID, scan_id: uuid.UUID
    ) -> dict[str, Any]:
        require_storage(self._storage)

        async def work(s: AsyncSession, scan: Scan) -> TxResult:
            shoes = await repo.load_shoes(s, [scan.id])
            if not shoes:
                raise ApiError(
                    409, "NO_SHOES", "Add at least one shoe before finishing"
                )
            incomplete = incomplete_shoes(
                [
                    ShoeViews(id=str(x.id), position=x.position, views=tuple(x.views))
                    for x in shoes
                ]
            )
            if incomplete:
                raise ApiError(
                    409,
                    "SCAN_INCOMPLETE",
                    "Every shoe needs all 4 views before finishing",
                    {"incomplete": incomplete},
                )
            await s.execute(
                update(Scan)
                .where(Scan.id == scan.id)
                .values(status="processing", finished_at=utcnow())
            )
            log.info("scan %s finished with %d shoe(s)", scan.id, len(shoes))

            from app.models.scan import ScanShoeResult
            from app.core.numbers import to_numeric
            from app.repositories import catalog as catalog_repo

            brands = await catalog_repo.brands(s, None, 5)
            primary_brand = brands[0].name if brands else "On Running"
            candidates = (
                [
                    {
                        "brand": b.name,
                        "model": "Sneaker",
                        "confidence": 0.5,
                    }
                    for b in brands[:3]
                ]
                if brands
                else [
                    {
                        "brand": "On Running",
                        "model": "Sneaker",
                        "confidence": 0.5,
                    }
                ]
            )

            for shoe in shoes:
                existing_res = (
                    await s.execute(
                        select(ScanShoeResult).where(
                            ScanShoeResult.scan_shoe_id == shoe.id
                        )
                    )
                ).scalar_one_or_none()
                if existing_res is None:
                    columns = {
                        "source": "server",
                        "outcome": "identified",
                        "model_version": "catalog-v1",
                        "brand": primary_brand,
                        "sub_brand": None,
                        "model": "Sneaker",
                        "colorway": "Original",
                        "category": "Athletic Shoes",
                        "subCategory": "Running Shoes",
                        "material": "Recycled Mesh",
                        "confidence": None,
                        "condition_code": "C2",
                        "candidates": candidates,
                        "raw": None,
                        "submitted_at": utcnow(),
                    }
                    await s.execute(
                        insert(ScanShoeResult).values(
                            scan_shoe_id=shoe.id, **columns
                        )
                    )
                    await s.execute(
                        update(ScanShoe)
                        .where(ScanShoe.id == shoe.id)
                        .values(status="identified")
                    )

            # Advance scan status to review so the user can immediately review & confirm
            await s.execute(
                update(Scan)
                .where(Scan.id == scan.id)
                .values(status="review")
            )
            return TxResult()

        return await self._in_draft_tx(session, user_id, scan_id, work)

    # ─── housekeeping ────────────────────────────────────────────────────────
    async def abandon_stale_drafts(self, now: datetime | None = None) -> int:
        now = now or utcnow()
        cutoff = now - timedelta(days=self._s.SCAN_DRAFT_ABANDON_DAYS)
        async with self._sessions() as session:
            stale = [
                r[0]
                for r in (
                    await session.execute(
                        select(Scan.id).where(
                            Scan.status == "draft", Scan.updated_at < cutoff
                        )
                    )
                ).all()
            ]
        n = 0
        for sid in stale:
            async with self._sessions() as session:
                res = await session.execute(
                    update(Scan)
                    .where(
                        Scan.id == sid, Scan.status == "draft", Scan.updated_at < cutoff
                    )
                    .values(status="abandoned")
                )
                if not int(getattr(res, "rowcount", 0) or 0):
                    await session.rollback()
                    continue
                keys = await self._purge_photos(session, sid)
                await session.commit()
            for k in keys:
                await safe_delete(self._storage, k)
            n += 1
        return n

    async def delete_all_for_user(
        self, session: AsyncSession, user_id: uuid.UUID
    ) -> int:
        ids = [
            r[0]
            for r in (
                await session.execute(select(Scan.id).where(Scan.user_id == user_id))
            ).all()
        ]
        keys: list[str] = []
        for sid in ids:
            keys.extend(await self._purge_photos(session, sid))
        if ids:
            await session.execute(delete(Scan).where(Scan.user_id == user_id))
        await session.commit()
        for k in keys:
            await safe_delete(self._storage, k)
        return len(ids)

    # ─── internals ───────────────────────────────────────────────────────────
    async def _in_draft_tx(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        work: Callable[[AsyncSession, Scan], Awaitable[TxResult]],
    ) -> dict[str, Any]:
        scan = await repo.find_owned_scan(session, user_id, scan_id, lock=True)
        assert_draft(scan)
        result = await work(session, scan)
        scan_pk = scan.id
        await repo.touch_scan(session, scan_pk)
        session.expire_all()  # re-read what the work and the touch changed
        fresh = await repo.find_owned_scan(session, user_id, scan_id)
        shoes = await repo.load_shoes(session, [scan_pk])
        view = await self._build_session(fresh, shoes)
        await session.commit()
        for key in result.after_commit_deletes:
            await safe_delete(self._storage, key)
        return view

    async def _purge_photos(
        self, session: AsyncSession, scan_id: uuid.UUID
    ) -> list[str]:
        photos = await repo.photos_of_scan(session, scan_id)
        if photos:
            await session.execute(
                delete(ScanPhoto).where(ScanPhoto.id.in_([p.id for p in photos]))
            )
        return [p.s3_key for p in photos]

    async def _refresh_shoe_status(
        self, session: AsyncSession, shoe_id: uuid.UUID
    ) -> None:
        views = await repo.photo_views(session, shoe_id)
        complete = compute_shoe_state(views).complete
        await session.execute(
            update(ScanShoe)
            .where(ScanShoe.id == shoe_id)
            .values(status="complete" if complete else "capturing")
        )

    async def _build_session(
        self, scan: Scan, shoes: list[ShoeWithPhotos]
    ) -> dict[str, Any]:
        ttl = self._s.SCAN_PHOTO_URL_TTL_SECONDS
        shoe_views: list[dict[str, Any]] = []
        for s in order_by_position(shoes):
            state = compute_shoe_state(s.views)
            photos = []
            for p in sorted(s.photos, key=lambda p: view_index(p.view)):
                photos.append(
                    {
                        "view": p.view,
                        "contentType": p.content_type,
                        "bytes": p.bytes,
                        "takenAt": to_js_iso(p.taken_at) if p.taken_at else None,
                        "updatedAt": to_js_iso(p.updated_at),
                        "url": await sign_or_null(self._storage, p.s3_key, ttl),
                    }
                )
            shoe_views.append(
                {
                    "id": str(s.id),
                    "position": s.position,
                    "label": label_for(s.position),
                    "status": s.shoe.status,
                    "complete": state.complete,
                    "missing": state.missing,
                    "photos": photos,
                }
            )
        return {
            "id": str(scan.id),
            "status": scan.status,
            "source": scan.source,
            "createdAt": to_js_iso(scan.created_at),
            "updatedAt": to_js_iso(scan.updated_at),
            "finishedAt": to_js_iso(scan.finished_at) if scan.finished_at else None,
            "canFinish": scan.status == "draft"
            and len(shoe_views) > 0
            and all(x["complete"] for x in shoe_views),
            "shoes": shoe_views,
        }
