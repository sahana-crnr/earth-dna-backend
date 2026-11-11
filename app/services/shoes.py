"""My Shoes profile, edit, photos, share, rescan, feedback (src/shoes/shoes.service.ts)."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import SHOE_VIEWS
from app.core.errors import ApiError
from app.core.numbers import num_out
from app.core.settings import Settings
from app.core.time import to_js_iso, utcnow
from app.models.catalog import CatalogShoeType
from app.models.scan import Scan, ScanPhoto, ScanShoe
from app.models.shoe import Shoe, ShoeFeedback, ShoePhoto, ShoeShare
from app.repositories import catalog as catalog_repo
from app.repositories import scans as scan_repo
from app.repositories import shoes as repo
from app.repositories.shoes import find_owned_shoe, not_found
from app.repositories.users import is_unique_violation
from app.services.scan_rules import CONTENT_TYPE, FILE_EXT
from app.services.shoe_rules import (
    EditableShoe,
    EditInput,
    PhotoRef,
    apply_edit,
    can_delete_photo,
    condition_view_for,
    is_valid_token,
    make_token,
    materials_for,
    next_primary,
    next_sort_order,
    pick_primary,
    random_part,
    share_url,
)
from app.services.storage import (
    PhotoStorage,
    put_or_throw,
    require_storage,
    safe_delete,
    sign_or_null,
    validate_uploaded_photo,
)
from app.services.values import ShoeValueProvider

log = logging.getLogger("app.shoes")

OPEN_RESCAN: tuple[str, ...] = ("draft", "processing", "review")
SHARE_TOKEN_ATTEMPTS = 5


def _s(v: uuid.UUID | None) -> str | None:
    return str(v) if v is not None else None


def _iso(d: Any) -> str | None:
    return to_js_iso(d) if d else None


class ShoesService:
    def __init__(
        self, settings: Settings, storage: PhotoStorage, values: ShoeValueProvider
    ) -> None:
        self._s = settings
        self._storage = storage
        self._values = values
        from app.services.scan_rules import Limits

        self._limits = Limits(
            photo_max_bytes=settings.SCAN_PHOTO_MAX_BYTES,
            allowed_types=tuple(settings.SCAN_PHOTO_ALLOWED_TYPES),
        )

    def share_base(self, request_api_base: str) -> str:
        return self._s.SHARE_BASE_URL or request_api_base

    # ─── E21 profile ─────────────────────────────────────────────────────────
    async def get_profile(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        shoe_id: uuid.UUID,
        share_base: str,
    ) -> dict[str, Any]:
        shoe = await find_owned_shoe(session, user_id, shoe_id)
        return await self.build_profile(session, shoe, share_base)

    # ─── E22 edit ────────────────────────────────────────────────────────────
    async def update(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        shoe_id: uuid.UUID,
        body: dict[str, Any],
        share_base: str,
    ) -> dict[str, Any]:
        if not body:
            raise ApiError(400, "EMPTY_UPDATE", "Send at least one field to change")
        shoe = await find_owned_shoe(session, user_id, shoe_id, lock=True)
        inp = EditInput()
        if "brandId" in body:
            row = await catalog_repo.brand_by_id(session, uuid.UUID(body["brandId"]))
            if row is None:
                raise ApiError(400, "UNKNOWN_BRAND", "Unknown or inactive brand id")
            inp.brand_id, inp.brand = row.id, row.name
        brand_for_size = inp.brand_id if "brandId" in body else shoe.brand_id
        if (
            "brandId" in body
            and inp.brand_id != shoe.brand_id
            and "sizeId" not in body
            and shoe.size_id is not None
        ):
            still = await catalog_repo.size_by_id(session, shoe.size_id, inp.brand_id)
            if still is None:
                inp.size_id, inp.size = None, None
        if "sizeId" in body:
            if body["sizeId"] is None:
                inp.size_id, inp.size = None, None
            else:
                srow = await catalog_repo.size_by_id(
                    session, uuid.UUID(body["sizeId"]), brand_for_size
                )
                if srow is None:
                    raise ApiError(
                        400,
                        "UNKNOWN_SIZE",
                        "Unknown size id, or the size does not belong to the brand",
                    )
                inp.size_id, inp.size = srow.id, srow.label
        if "shoeTypeId" in body:
            if body["shoeTypeId"] is None:
                inp.shoe_type_id, inp.shoe_type = None, None
            else:
                trow = await catalog_repo.shoe_type_by_id(
                    session, uuid.UUID(body["shoeTypeId"])
                )
                if trow is None:
                    raise ApiError(
                        400, "UNKNOWN_SHOE_TYPE", "Unknown or inactive shoe type id"
                    )
                inp.shoe_type_id, inp.shoe_type = trow.id, trow.name
        if "primaryPhotoId" in body:
            owned = (
                await session.execute(
                    select(ShoePhoto.id).where(
                        ShoePhoto.id == uuid.UUID(body["primaryPhotoId"]),
                        ShoePhoto.shoe_id == shoe.id,
                    )
                )
            ).scalar_one_or_none()
            if owned is None:
                raise ApiError(
                    400, "UNKNOWN_PHOTO", "primaryPhotoId is not a photo of this shoe"
                )
            inp.primary_photo_id = owned
        if "model" in body:
            inp.model = body["model"]
        if "color" in body:
            inp.color = body["color"]
        if "gender" in body:
            inp.gender = body["gender"]
        if "actionTaken" in body:
            inp.action_taken = body["actionTaken"]
        edit = apply_edit(_editable(shoe), inp, utcnow())
        if edit.changed:
            n = edit.next
            patch: dict[str, Any] = {
                "brand_id": n.brand_id,
                "brand": n.brand,
                "model": n.model,
                "colorway": n.colorway,
                "size_id": n.size_id,
                "size": n.size,
                "shoe_type_id": n.shoe_type_id,
                "shoe_type": n.shoe_type,
                "gender": n.gender,
                "action_taken": n.action_taken,
                "action_taken_at": n.action_taken_at,
                "primary_photo_id": n.primary_photo_id,
            }
            if edit.rematch:
                product = await catalog_repo.match_product(
                    session, n.brand_id, n.model, n.colorway, n.size
                )
                patch["catalog_product_id"] = product.id if product else None
                patch["msrp"] = product.msrp if product else None
            if edit.revalue and shoe.value_source == "static":
                v = await self._values.value_for(
                    str(shoe.scan_shoe_id or shoe.id),
                    n.brand,
                    n.model,
                    shoe.condition_code,
                )
                patch.update(v.as_columns(utcnow()))
            await session.execute(
                update(Shoe).where(Shoe.id == shoe.id).values(**patch)
            )
            log.info("shoe %s edited: %s", shoe.id, ", ".join(sorted(edit.changed)))
        session.expire_all()
        fresh = await find_owned_shoe(session, user_id, shoe_id)
        view = await self.build_profile(session, fresh, share_base)
        await session.commit()
        return view

    # ─── E23 remove ──────────────────────────────────────────────────────────
    async def remove(
        self, session: AsyncSession, user_id: uuid.UUID, shoe_id: uuid.UUID
    ) -> None:
        shoe = await find_owned_shoe(session, user_id, shoe_id, lock=True)
        now = utcnow()
        await session.execute(
            update(Shoe).where(Shoe.id == shoe.id).values(deleted_at=now)
        )
        await session.execute(
            update(ShoeShare)
            .where(ShoeShare.shoe_id == shoe.id, ShoeShare.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        drafts = [
            r[0]
            for r in (
                await session.execute(
                    select(Scan.id)
                    .join(ScanShoe, ScanShoe.scan_id == Scan.id)
                    .where(
                        ScanShoe.rescan_of_shoe_id == shoe.id, Scan.status == "draft"
                    )
                )
            ).all()
        ]
        if drafts:
            await session.execute(
                update(Scan).where(Scan.id.in_(drafts)).values(status="abandoned")
            )
        await self.hide_scan_if_orphaned(session, shoe.scan_shoe_id, now)
        await session.commit()
        log.info("shoe %s removed", shoe.id)

    # ─── E27 add photo ───────────────────────────────────────────────────────
    async def upload_photo(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        shoe_id: uuid.UUID,
        data: bytes | None,
        share_base: str,
    ) -> dict[str, Any]:
        require_storage(self._storage)
        photo_type = validate_uploaded_photo(data, self._limits)
        assert data is not None
        shoe = await find_owned_shoe(session, user_id, shoe_id)
        count = int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(ShoePhoto)
                    .where(ShoePhoto.shoe_id == shoe.id)
                )
            ).scalar_one()
        )
        self._assert_photo_room(count)
        shoe_pk = shoe.id
        await session.rollback()
        photo_id = uuid.uuid4()
        key = f"{self._s.SHOE_UPLOAD_PREFIX}/{user_id}/{shoe_pk}/{photo_id}.{FILE_EXT[photo_type]}"
        await put_or_throw(self._storage, key, data, CONTENT_TYPE[photo_type])
        try:
            locked = await find_owned_shoe(session, user_id, shoe_id, lock=True)
            photos = await repo.photos_of(session, locked.id)
            self._assert_photo_room(len(photos))
            await session.execute(
                insert(ShoePhoto).values(
                    id=photo_id,
                    shoe_id=locked.id,
                    source="upload",
                    scan_photo_id=None,
                    view=None,
                    s3_key=key,
                    content_type=CONTENT_TYPE[photo_type],
                    size_bytes=len(data),
                    sort_order=next_sort_order(photos),
                )
            )
            if locked.primary_photo_id is None:
                await session.execute(
                    update(Shoe)
                    .where(Shoe.id == locked.id)
                    .values(primary_photo_id=photo_id)
                )
            session.expire_all()
            fresh = await find_owned_shoe(session, user_id, shoe_id)
            view = await self.build_profile(session, fresh, share_base)
            await session.commit()
            return view
        except Exception:
            await safe_delete(self._storage, key)
            raise

    # ─── E28 delete photo ────────────────────────────────────────────────────
    async def delete_photo(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        shoe_id: uuid.UUID,
        photo_id: uuid.UUID,
        share_base: str,
    ) -> dict[str, Any]:
        shoe = await find_owned_shoe(session, user_id, shoe_id, lock=True)
        photos = await repo.photos_of(session, shoe.id)
        target = next((p for p in photos if p.id == photo_id), None)
        if target is None:
            raise not_found("PHOTO_NOT_FOUND", "Photo not found")
        if target.source == "scan":
            raise ApiError(
                409,
                "SCAN_PHOTO_FIXED",
                "Scan photos are replaced by a rescan, not deleted",
            )
        if not can_delete_photo(len(photos)):
            raise ApiError(409, "LAST_PHOTO", "A shoe keeps at least one photo")
        remove_key = target.s3_key if target.source == "upload" else None
        await session.execute(delete(ShoePhoto).where(ShoePhoto.id == target.id))
        if shoe.primary_photo_id == target.id:
            nxt = next_primary(
                [PhotoRef(str(p.id), p.sort_order, p.created_at) for p in photos],
                str(target.id),
            )
            await session.execute(
                update(Shoe)
                .where(Shoe.id == shoe.id)
                .values(primary_photo_id=uuid.UUID(nxt) if nxt else None)
            )
        session.expire_all()
        fresh = await find_owned_shoe(session, user_id, shoe_id)
        view = await self.build_profile(session, fresh, share_base)
        await session.commit()
        if remove_key:
            await safe_delete(self._storage, remove_key)
        return view

    # ─── E24 / E25 share ─────────────────────────────────────────────────────
    async def create_share(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        shoe_id: uuid.UUID,
        share_base: str,
    ) -> tuple[bool, dict[str, Any]]:
        shoe = await find_owned_shoe(session, user_id, shoe_id, lock=True)
        active = await repo.active_share(session, shoe.id)
        if active is not None:
            await session.commit()
            return False, self._link_view(active, share_base)
        for _ in range(SHARE_TOKEN_ATTEMPTS):
            token = make_token(
                shoe.model, shoe.brand, random_part(self._s.SHARE_TOKEN_RANDOM_CHARS)
            )
            nested = await session.begin_nested()
            try:
                share = ShoeShare(shoe_id=shoe.id, token=token)
                session.add(share)
                await session.flush()
                await nested.commit()
            except IntegrityError as exc:
                await nested.rollback()
                if not is_unique_violation(exc):
                    raise
                continue
            await session.refresh(share)
            view = self._link_view(share, share_base)
            await session.commit()
            log.info("shoe %s share created", shoe.id)
            return True, view
        raise ApiError(
            409, "SHARE_TOKEN_EXHAUSTED", "Could not allocate a share link, try again"
        )

    async def revoke_share(
        self, session: AsyncSession, user_id: uuid.UUID, shoe_id: uuid.UUID
    ) -> None:
        shoe = await find_owned_shoe(session, user_id, shoe_id, lock=True)
        res = await session.execute(
            update(ShoeShare)
            .where(ShoeShare.shoe_id == shoe.id, ShoeShare.revoked_at.is_(None))
            .values(revoked_at=utcnow())
        )
        await session.commit()
        if int(getattr(res, "rowcount", 0) or 0):
            log.info("shoe %s share revoked", shoe.id)

    # ─── E26 public view ─────────────────────────────────────────────────────
    async def public_view(
        self, session: AsyncSession, token: str
    ) -> dict[str, Any] | None:
        if not is_valid_token(token):
            return None
        share = (
            await session.execute(select(ShoeShare).where(ShoeShare.token == token))
        ).scalar_one_or_none()
        if share is None or share.revoked_at is not None:
            return None
        if share.expires_at is not None and share.expires_at < utcnow():
            return None
        shoe = (
            await session.execute(
                select(Shoe).where(Shoe.id == share.shoe_id, Shoe.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if shoe is None:
            return None
        primary = (
            await session.get(ShoePhoto, shoe.primary_photo_id)
            if shoe.primary_photo_id
            else None
        )
        mappings = await catalog_repo.condition_mappings(session)
        condition = condition_view_for(shoe.condition_code, mappings)
        try:
            await session.execute(
                update(ShoeShare)
                .where(ShoeShare.id == share.id)
                .values(view_count=ShoeShare.view_count + 1)
            )
            await session.commit()
        except Exception as exc:
            log.warning("viewCount %s: %s", share.id, exc)
        return {
            "brand": shoe.brand,
            "model": shoe.model,
            "shoeType": shoe.shoe_type,
            "color": shoe.colorway,
            "condition": {"grade": condition["grade"], "label": condition["label"]},
            "value": {
                "min": num_out(shoe.resale_min),
                "max": num_out(shoe.resale_max),
                "currency": shoe.resale_currency,
            },
            "recommendedAction": shoe.recommended_action,
            "photoUrl": await self._sign(primary.s3_key) if primary else None,
            "sharedAt": to_js_iso(share.created_at),
        }

    # ─── E29 rescan ──────────────────────────────────────────────────────────
    async def rescan(
        self, session: AsyncSession, user_id: uuid.UUID, shoe_id: uuid.UUID
    ) -> dict[str, Any]:
        require_storage(self._storage)
        shoe = await find_owned_shoe(session, user_id, shoe_id, lock=True)
        open_ = await self._open_rescan(session, shoe.id)
        if open_ is not None:
            await session.commit()
            return {**open_, "created": False}
        await scan_repo.assert_draft_room(
            session, user_id, self._s.SCAN_MAX_OPEN_DRAFTS
        )
        scan = Scan(user_id=user_id, status="draft", source="camera")
        session.add(scan)
        await session.flush()
        scan_shoe = ScanShoe(
            scan_id=scan.id, position=1, status="capturing", rescan_of_shoe_id=shoe.id
        )
        session.add(scan_shoe)
        await session.flush()
        view = {
            "scanId": str(scan.id),
            "shoeId": str(scan_shoe.id),
            "status": scan.status,
            "created": True,
        }
        await session.commit()
        log.info("shoe %s rescan %s", shoe_id, view["scanId"])
        return view

    # ─── E30 condition feedback ──────────────────────────────────────────────
    async def suggest_condition(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        shoe_id: uuid.UUID,
        code: str,
        reason: str,
    ) -> dict[str, Any]:
        shoe = await find_owned_shoe(session, user_id, shoe_id)
        row = ShoeFeedback(
            scan_shoe_id=shoe.scan_shoe_id,
            shoe_id=shoe.id,
            user_id=user_id,
            type="condition_suggested",
            model_version=None,
            original={"conditionCode": shoe.condition_code},
            answer={"suggestedConditionCode": code, "reason": reason},
        )
        session.add(row)
        await session.flush()
        await session.refresh(row)
        created = row.created_at
        await session.commit()
        log.info("shoe %s condition suggested", shoe.id)
        return {
            "suggestedConditionCode": code,
            "reason": reason,
            "createdAt": to_js_iso(created),
        }

    # ─── helpers used by the review service ──────────────────────────────────
    async def hide_scan_if_orphaned(
        self, session: AsyncSession, scan_shoe_id: uuid.UUID | None, now: Any = None
    ) -> None:
        if scan_shoe_id is None:
            return
        row = (
            await session.execute(
                select(ScanShoe.scan_id).where(ScanShoe.id == scan_shoe_id)
            )
        ).scalar_one_or_none()
        if row is None:
            return
        scan_id = row
        live = int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(Shoe)
                    .join(ScanShoe, ScanShoe.id == Shoe.scan_shoe_id)
                    .where(ScanShoe.scan_id == scan_id, Shoe.deleted_at.is_(None))
                )
            ).scalar_one()
        )
        pending = int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(ScanShoe)
                    .where(
                        ScanShoe.scan_id == scan_id,
                        ScanShoe.status.not_in(["confirmed", "rejected"]),
                    )
                )
            ).scalar_one()
        )
        hidden = live == 0 and pending == 0
        await session.execute(
            update(Scan)
            .where(Scan.id == scan_id)
            .values(hidden_at=(now or utcnow()) if hidden else None)
        )

    async def delete_all_uploads_for_user(
        self, session: AsyncSession, user_id: uuid.UUID
    ) -> int:
        rows = (
            await session.execute(
                select(ShoePhoto.id, ShoePhoto.s3_key)
                .join(Shoe, Shoe.id == ShoePhoto.shoe_id)
                .where(Shoe.user_id == user_id, ShoePhoto.source == "upload")
            )
        ).all()
        if rows:
            await session.execute(
                delete(ShoePhoto).where(ShoePhoto.id.in_([r[0] for r in rows]))
            )
        await session.commit()
        for r in rows:
            await safe_delete(self._storage, str(r[1]))
        return len(rows)

    async def attach_scan_photos(
        self,
        session: AsyncSession,
        shoe_id: uuid.UUID,
        scan_shoe_id: uuid.UUID,
        preferred: str,
    ) -> None:
        existing = await repo.photos_of(session, shoe_id)
        inserted = await self._insert_scan_rows(
            session, shoe_id, scan_shoe_id, next_sort_order(existing)
        )
        primary = pick_primary([(str(i), v) for i, v in inserted], preferred)
        if primary:
            await session.execute(
                update(Shoe)
                .where(Shoe.id == shoe_id)
                .values(primary_photo_id=uuid.UUID(primary))
            )

    async def replace_scan_photos(
        self,
        session: AsyncSession,
        shoe_id: uuid.UUID,
        scan_shoe_id: uuid.UUID,
        preferred: str,
    ) -> None:
        existing = await repo.photos_of(session, shoe_id)
        old_scan = [p for p in existing if p.source == "scan"]
        if old_scan:
            await session.execute(
                delete(ShoePhoto).where(ShoePhoto.id.in_([p.id for p in old_scan]))
            )
        uploads = [p for p in existing if p.source == "upload"]
        inserted = await self._insert_scan_rows(session, shoe_id, scan_shoe_id, 0)
        for i, u in enumerate(uploads):
            await session.execute(
                update(ShoePhoto)
                .where(ShoePhoto.id == u.id)
                .values(sort_order=len(inserted) + i)
            )
        current_primary = (
            await session.execute(
                select(Shoe.primary_photo_id).where(Shoe.id == shoe_id)
            )
        ).scalar_one_or_none()
        primary_was_scan = current_primary is None or any(
            p.id == current_primary for p in old_scan
        )
        if primary_was_scan:
            primary = pick_primary([(str(i), v) for i, v in inserted], preferred) or (
                str(uploads[0].id) if uploads else None
            )
            await session.execute(
                update(Shoe)
                .where(Shoe.id == shoe_id)
                .values(primary_photo_id=uuid.UUID(primary) if primary else None)
            )
        overflow = len(inserted) + len(uploads) - self._s.SHOE_MAX_PHOTOS
        if overflow > 0:
            drop = uploads[len(uploads) - overflow :]
            await session.execute(
                delete(ShoePhoto).where(ShoePhoto.id.in_([p.id for p in drop]))
            )
            log.warning(
                "shoe %s: %d upload(s) dropped to respect the cap", shoe_id, len(drop)
            )

    async def build_profile(
        self, session: AsyncSession, shoe: Shoe, share_base: str
    ) -> dict[str, Any]:
        photos = await repo.photos_of(session, shoe.id)
        share = await repo.active_share(session, shoe.id)
        mappings = await catalog_repo.condition_mappings(session)
        feedback = await repo.latest_condition_feedback(session, shoe.id)
        rescan = await self._open_rescan(session, shoe.id)
        scan_id = (
            (
                await session.execute(
                    select(ScanShoe.scan_id).where(ScanShoe.id == shoe.scan_shoe_id)
                )
            ).scalar_one_or_none()
            if shoe.scan_shoe_id
            else None
        )
        type_slug = (
            (
                await session.execute(
                    select(CatalogShoeType.slug).where(
                        CatalogShoeType.id == shoe.shoe_type_id
                    )
                )
            ).scalar_one_or_none()
            if shoe.shoe_type_id
            else None
        )
        photo_views = [
            {
                "id": str(p.id),
                "source": p.source,
                "view": p.view,
                "url": await self._sign(p.s3_key),
                "isPrimary": p.id == shoe.primary_photo_id,
                "sortOrder": p.sort_order,
                "createdAt": to_js_iso(p.created_at),
            }
            for p in photos
        ]
        answer = feedback.answer if feedback is not None else {}
        return {
            "id": str(shoe.id),
            "brand": {"id": _s(shoe.brand_id), "name": shoe.brand},
            "subBrand": shoe.sub_brand,
            "model": shoe.model,
            "shoeType": {"id": _s(shoe.shoe_type_id), "name": shoe.shoe_type},
            "category": shoe.category,
            "subCategory": shoe.sub_category,
            "color": shoe.colorway,
            "size": {"id": _s(shoe.size_id), "label": shoe.size},
            "gender": shoe.gender,
            "condition": condition_view_for(shoe.condition_code, mappings),
            "conditionFeedback": {
                "suggestedConditionCode": answer.get("suggestedConditionCode")
                if isinstance(answer.get("suggestedConditionCode"), str)
                else "",
                "reason": answer.get("reason")
                if isinstance(answer.get("reason"), str)
                else "",
                "createdAt": to_js_iso(feedback.created_at),
            }
            if feedback is not None
            else None,
            "material": shoe.material,
            "value": {
                "min": num_out(shoe.resale_min),
                "max": num_out(shoe.resale_max),
                "currency": shoe.resale_currency,
                "demandNote": shoe.demand_note,
                "source": shoe.value_source,
                "version": shoe.value_source_version,
                "computedAt": _iso(shoe.value_computed_at),
            },
            "recommendation": {
                "action": shoe.recommended_action,
                "reason": shoe.recommendation_reason,
            },
            "materials": materials_for(type_slug),
            "circularSort": {"status": "pending"},
            "photos": photo_views,
            "actionTaken": shoe.action_taken,
            "actionTakenAt": _iso(shoe.action_taken_at),
            "share": {
                "active": share is not None,
                "url": share_url(share_base, share.token) if share else None,
                "createdAt": to_js_iso(share.created_at) if share else None,
            },
            "scan": {"scanId": _s(scan_id), "scanShoeId": _s(shoe.scan_shoe_id)},
            "rescan": rescan,
            "createdAt": to_js_iso(shoe.created_at),
            "updatedAt": to_js_iso(shoe.updated_at),
        }

    async def _open_rescan(
        self, session: AsyncSession, shoe_id: uuid.UUID
    ) -> dict[str, Any] | None:
        row = (
            await session.execute(
                select(ScanShoe.id, ScanShoe.scan_id, Scan.status)
                .join(Scan, Scan.id == ScanShoe.scan_id)
                .where(
                    ScanShoe.rescan_of_shoe_id == shoe_id, Scan.status.in_(OPEN_RESCAN)
                )
                .order_by(ScanShoe.created_at.desc())
                .limit(1)
            )
        ).first()
        if row is None:
            return None
        return {"scanId": str(row[1]), "shoeId": str(row[0]), "status": row[2]}

    async def _insert_scan_rows(
        self,
        session: AsyncSession,
        shoe_id: uuid.UUID,
        scan_shoe_id: uuid.UUID,
        start_order: int,
    ) -> list[tuple[uuid.UUID, str | None]]:
        photos = list(
            (
                await session.execute(
                    select(ScanPhoto).where(ScanPhoto.scan_shoe_id == scan_shoe_id)
                )
            ).scalars()
        )
        ordered = sorted(
            photos,
            key=lambda p: SHOE_VIEWS.index(p.view) if p.view in SHOE_VIEWS else 9,
        )
        out: list[tuple[uuid.UUID, str | None]] = []
        for i, p in enumerate(ordered):
            pid = uuid.uuid4()
            await session.execute(
                insert(ShoePhoto).values(
                    id=pid,
                    shoe_id=shoe_id,
                    source="scan",
                    scan_photo_id=p.id,
                    view=p.view,
                    s3_key=p.s3_key,
                    content_type=p.content_type,
                    size_bytes=p.bytes,
                    sort_order=start_order + i,
                )
            )
            out.append((pid, p.view))
        return out

    def _link_view(self, share: ShoeShare, base: str) -> dict[str, Any]:
        return {
            "url": share_url(base, share.token),
            "token": share.token,
            "createdAt": to_js_iso(share.created_at),
        }

    def _assert_photo_room(self, count: int) -> None:
        if count >= self._s.SHOE_MAX_PHOTOS:
            raise ApiError(
                409,
                "PHOTO_LIMIT_REACHED",
                f"A shoe can hold at most {self._s.SHOE_MAX_PHOTOS} photos",
            )

    async def _sign(self, key: str) -> str | None:
        return await sign_or_null(
            self._storage, key, self._s.SHOE_PHOTO_URL_TTL_SECONDS
        )


def _editable(s: Shoe) -> EditableShoe:
    return EditableShoe(
        brand_id=s.brand_id,
        brand=s.brand,
        model=s.model,
        colorway=s.colorway,
        size_id=s.size_id,
        size=s.size,
        shoe_type_id=s.shoe_type_id,
        shoe_type=s.shoe_type,
        gender=s.gender,
        action_taken=s.action_taken,
        action_taken_at=s.action_taken_at,
        primary_photo_id=s.primary_photo_id,
    )
