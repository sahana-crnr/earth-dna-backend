"""F3 review: E12 confirm / E13 reject (src/scan/scan-review.service.ts).

Creates (or, for a rescan, updates in place) the My Shoes entry from the
prediction overlaid with the user's answer, writes the training feedback row,
marks the shoe reviewed and completes the scan once every shoe is reviewed.
"""

from __future__ import annotations

import logging
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.core.numbers import num_out
from app.core.settings import Settings
from app.core.time import utcnow
from app.models.scan import Scan, ScanShoe, ScanShoeResult
from app.models.shoe import Shoe, ShoeFeedback
from app.repositories import catalog as catalog_repo
from app.repositories import scans as scan_repo
from app.repositories.scans import not_found
from app.services.results import ScanResultsBuilder
from app.services.review_rules import (
    Answer,
    Identity,
    Predicted,
    brand_corrected,
    is_completed,
    missing_fields,
    overlay_details,
)
from app.services.shoes import ShoesService
from app.services.values import ShoeValueProvider

log = logging.getLogger("app.review")

REVIEWABLE: tuple[str, ...] = ("review", "processing", "completed")


def _prediction_json(r: ScanShoeResult) -> dict[str, Any]:
    return {
        "brand": r.brand,
        "subBrand": r.sub_brand,
        "model": r.model,
        "colorway": r.colorway,
        "category": r.category,
        "subCategory": r.sub_category,
        "material": r.material,
        "confidence": num_out(r.confidence),
        "conditionCode": r.condition_code,
        "outcome": r.outcome,
        "source": r.source,
    }


def _s(v: uuid.UUID | None) -> str | None:
    return str(v) if v is not None else None


class ScanReviewService:
    def __init__(
        self,
        settings: Settings,
        builder: ScanResultsBuilder,
        shoes: ShoesService,
        values: ShoeValueProvider,
    ) -> None:
        self._s = settings
        self._builder = builder
        self._shoes = shoes
        self._values = values

    async def confirm(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        shoe_id: uuid.UUID,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        return await self._review("confirm", session, user_id, scan_id, shoe_id, body)

    async def reject(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        shoe_id: uuid.UUID,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        return await self._review("reject", session, user_id, scan_id, shoe_id, body)

    async def _review(
        self,
        mode: str,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        shoe_id: uuid.UUID,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        scan = await scan_repo.find_owned_scan(session, user_id, scan_id, lock=True)
        if scan.status not in REVIEWABLE:
            raise ApiError(
                409,
                "NOT_IN_REVIEW",
                "Scan is still a draft; finish it and submit results first"
                if scan.status == "draft"
                else f"Scan is {scan.status}; it cannot be reviewed",
            )
        shoe = await scan_repo.shoe_in_scan(session, shoe_id, scan.id)
        if shoe is None:
            raise not_found("SHOE_NOT_FOUND", "Shoe not found")
        if shoe.status in ("confirmed", "rejected"):
            existing_id = (
                await session.execute(
                    select(Shoe.id).where(Shoe.scan_shoe_id == shoe.id)
                )
            ).scalar_one_or_none()
            raise ApiError(
                409,
                "ALREADY_REVIEWED",
                f"Shoe is already {shoe.status}",
                {"review": shoe.status, "myShoeId": _s(existing_id)},
            )
        result = (
            await session.execute(
                select(ScanShoeResult).where(ScanShoeResult.scan_shoe_id == shoe.id)
            )
        ).scalar_one_or_none()
        if result is None:
            raise ApiError(
                409,
                "NO_RESULT",
                "Shoe has no identification result yet; submit one first",
            )

        brand_id_in = body.get("brandId")
        brand_row = (
            await catalog_repo.brand_by_id(session, uuid.UUID(brand_id_in))
            if brand_id_in
            else None
        )
        if brand_id_in and brand_row is None:
            raise ApiError(400, "UNKNOWN_BRAND", "Unknown or inactive brand id")
        predicted_brand_row = brand_row or await catalog_repo.brand_by_name(
            session, result.brand
        )
        size_id_in = body.get("sizeId")
        size_row = (
            await catalog_repo.size_by_id(
                session,
                uuid.UUID(size_id_in),
                predicted_brand_row.id if predicted_brand_row else None,
            )
            if size_id_in
            else None
        )
        if size_id_in and size_row is None:
            raise ApiError(
                400,
                "UNKNOWN_SIZE",
                "Unknown size id, or the size does not belong to the chosen brand",
            )
        answer = Answer(
            brand=brand_row.name if brand_row else None,
            model=body.get("model"),
            color=body.get("color"),
            size=size_row.label if size_row else None,
            gender=body.get("gender"),
        )
        missing = missing_fields(mode, answer)
        if missing:
            raise ApiError(
                400,
                "FIELDS_REQUIRED",
                "Reject needs the full answer",
                {"missing": missing},
            )
        identity = overlay_details(
            Predicted(
                brand=result.brand,
                model=result.model,
                colorway=result.colorway,
                sub_brand=result.sub_brand,
                category=result.category,
                sub_category=result.sub_category,
                condition_code=result.condition_code,
                material=result.material,
            ),
            answer,
        )
        if not identity.brand:
            raise ApiError(
                400,
                "BRAND_REQUIRED",
                "The prediction has no usable brand; send brandId",
            )
        corrected = mode == "reject" or brand_corrected(
            result.brand, brand_row.name if brand_row else None
        )
        resolved_brand = brand_row or predicted_brand_row
        product = await catalog_repo.match_product(
            session,
            resolved_brand.id if resolved_brand else None,
            identity.model,
            identity.color,
            identity.size,
        )
        shoe_type = await catalog_repo.shoe_type_for_category(
            session, identity.category
        )
        value_fields = (
            await self._value_fields(str(shoe.id), identity)
            if self._s.SHOE_VALUE_PLACEHOLDER
            else {}
        )

        rescan_of: Shoe | None = None
        if shoe.rescan_of_shoe_id is not None:
            rescan_of = (
                await session.execute(
                    select(Shoe)
                    .where(
                        Shoe.id == shoe.rescan_of_shoe_id,
                        Shoe.user_id == user_id,
                        Shoe.deleted_at.is_(None),
                    )
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if rescan_of is None:
                raise ApiError(
                    409,
                    "RESCAN_TARGET_REMOVED",
                    "The shoe this rescan belongs to was removed",
                )
        resolved_brand_id = resolved_brand.id if resolved_brand else None
        resolved_brand_name = resolved_brand.name if resolved_brand else identity.brand
        if rescan_of is not None:
            return await self._complete_rescan(
                session,
                user_id=user_id,
                mode=mode,
                scan=scan,
                shoe=shoe,
                result=result,
                existing=rescan_of,
                identity=identity,
                resolved_brand_id=resolved_brand_id,
                resolved_brand_name=resolved_brand_name,
                size_id=size_row.id if size_row else None,
                product_id=product.id if product else None,
                msrp=product.msrp if product else None,
                shoe_type_id=shoe_type.id if shoe_type else None,
                shoe_type_name=shoe_type.name if shoe_type else None,
                value_fields=value_fields,
            )

        entry = Shoe(
            user_id=user_id,
            scan_shoe_id=shoe.id,
            brand_id=resolved_brand_id,
            brand=resolved_brand_name,
            sub_brand=identity.sub_brand,
            category=identity.category,
            sub_category=identity.sub_category,
            model=identity.model,
            colorway=identity.color,
            size_id=size_row.id if size_row else None,
            size=identity.size,
            gender=identity.gender,
            condition_code=identity.condition_code,
            material=identity.material,
            catalog_product_id=product.id if product else None,
            msrp=product.msrp if product else None,
            shoe_type_id=shoe_type.id if shoe_type else None,
            shoe_type=shoe_type.name if shoe_type else None,
            **value_fields,
        )
        session.add(entry)
        await session.flush()
        await session.refresh(entry)
        await self._shoes.attach_scan_photos(
            session, entry.id, shoe.id, self._s.SHOE_THUMBNAIL_VIEW
        )
        await session.execute(
            insert(ShoeFeedback).values(
                scan_shoe_id=shoe.id,
                shoe_id=entry.id,
                user_id=user_id,
                type="corrected" if corrected else "confirmed",
                model_version=result.model_version,
                original={
                    **_prediction_json(result),
                    "candidates": result.candidates or [],
                },
                answer={
                    "brandId": _s(resolved_brand_id),
                    "brand": entry.brand,
                    "model": entry.model,
                    "color": entry.colorway,
                    "sizeId": _s(entry.size_id),
                    "size": entry.size,
                    "gender": entry.gender,
                    "catalogProductId": _s(entry.catalog_product_id),
                },
            )
        )
        await self._finish_review(session, scan, shoe, mode)
        all_shoes = await self._all_shoes(session, scan.id)
        if is_completed([s.status for s in all_shoes]) and scan.status != "completed":
            await session.execute(
                update(Scan).where(Scan.id == scan.id).values(status="completed")
            )
            scan.status = "completed"
            log.info("scan %s completed (%d shoe(s) reviewed)", scan.id, len(all_shoes))
        await scan_repo.touch_scan(session, scan.id)
        log.info("scan %s shoe %s %s → my shoe %s", scan.id, shoe.id, mode, entry.id)
        scan_pk = scan.id
        session.expire_all()
        scan_fresh = (
            await session.execute(select(Scan).where(Scan.id == scan_pk))
        ).scalar_one()
        view = await self._builder.build(
            session, scan_fresh, False, await self._all_shoes(session, scan_pk)
        )
        await session.commit()
        return view

    async def _finish_review(
        self, session: AsyncSession, scan: Scan, shoe: ScanShoe, mode: str
    ) -> None:
        await session.execute(
            update(ScanShoe)
            .where(ScanShoe.id == shoe.id)
            .values(status="confirmed" if mode == "confirm" else "rejected")
        )

    async def _all_shoes(
        self, session: AsyncSession, scan_id: uuid.UUID
    ) -> list[ScanShoe]:
        return list(
            (
                await session.execute(
                    select(ScanShoe)
                    .where(ScanShoe.scan_id == scan_id)
                    .order_by(ScanShoe.position.asc())
                )
            ).scalars()
        )

    async def _value_fields(self, shoe_id: str, identity: Identity) -> dict[str, Any]:
        v = await self._values.value_for(
            shoe_id, identity.brand, identity.model, identity.condition_code
        )
        return v.as_columns(utcnow())

    async def _complete_rescan(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        mode: str,
        scan: Scan,
        shoe: ScanShoe,
        result: ScanShoeResult,
        existing: Shoe,
        identity: Identity,
        resolved_brand_id: uuid.UUID | None,
        resolved_brand_name: str | None,
        size_id: uuid.UUID | None,
        product_id: uuid.UUID | None,
        msrp: Decimal | None,
        shoe_type_id: uuid.UUID | None,
        shoe_type_name: str | None,
        value_fields: dict[str, Any],
    ) -> dict[str, Any]:
        e = existing
        previous = {
            "scanShoeId": _s(e.scan_shoe_id),
            "brandId": _s(e.brand_id),
            "brand": e.brand,
            "subBrand": e.sub_brand,
            "category": e.category,
            "subCategory": e.sub_category,
            "model": e.model,
            "colorway": e.colorway,
            "sizeId": _s(e.size_id),
            "size": e.size,
            "gender": e.gender,
            "conditionCode": e.condition_code,
            "material": e.material,
            "shoeTypeId": _s(e.shoe_type_id),
            "catalogProductId": _s(e.catalog_product_id),
            "msrp": num_out(e.msrp),
        }
        previous_scan_shoe_id = e.scan_shoe_id
        patch: dict[str, Any] = {
            "scan_shoe_id": shoe.id,
            "brand_id": resolved_brand_id,
            "brand": resolved_brand_name or e.brand,
            "sub_brand": identity.sub_brand,
            "category": identity.category,
            "sub_category": identity.sub_category,
            "model": identity.model,
            "colorway": identity.color,
            "size_id": size_id if size_id is not None else e.size_id,
            "size": identity.size if identity.size is not None else e.size,
            "gender": identity.gender if identity.gender is not None else e.gender,
            "condition_code": identity.condition_code,
            "material": identity.material,
            "shoe_type_id": shoe_type_id
            if shoe_type_id is not None
            else e.shoe_type_id,
            "shoe_type": shoe_type_name if shoe_type_name is not None else e.shoe_type,
            "catalog_product_id": product_id,
            "msrp": msrp,
        }
        if e.value_source == "static":
            patch.update(value_fields)
        await session.execute(update(Shoe).where(Shoe.id == e.id).values(**patch))
        await self._shoes.replace_scan_photos(
            session, e.id, shoe.id, self._s.SHOE_THUMBNAIL_VIEW
        )
        await self._shoes.hide_scan_if_orphaned(session, previous_scan_shoe_id)
        await session.execute(
            insert(ShoeFeedback).values(
                scan_shoe_id=shoe.id,
                shoe_id=e.id,
                user_id=user_id,
                type="rescanned",
                model_version=result.model_version,
                original={"previous": previous, "prediction": _prediction_json(result)},
                answer={
                    "mode": mode,
                    "brandId": _s(resolved_brand_id),
                    "brand": patch["brand"],
                    "model": patch["model"],
                    "color": patch["colorway"],
                    "sizeId": _s(patch["size_id"]),
                    "size": patch["size"],
                    "gender": patch["gender"],
                    "conditionCode": patch["condition_code"],
                    "catalogProductId": _s(patch["catalog_product_id"]),
                },
            )
        )
        await self._finish_review(session, scan, shoe, mode)
        all_shoes = await self._all_shoes(session, scan.id)
        if is_completed([s.status for s in all_shoes]) and scan.status != "completed":
            await session.execute(
                update(Scan).where(Scan.id == scan.id).values(status="completed")
            )
            scan.status = "completed"
        await scan_repo.touch_scan(session, scan.id)
        log.info(
            "scan %s shoe %s %s → rescan of my shoe %s applied",
            scan.id,
            shoe.id,
            mode,
            e.id,
        )
        scan_pk = scan.id
        session.expire_all()
        scan_fresh = (
            await session.execute(select(Scan).where(Scan.id == scan_pk))
        ).scalar_one()
        view = await self._builder.build(
            session, scan_fresh, False, await self._all_shoes(session, scan_pk)
        )
        await session.commit()
        return view
