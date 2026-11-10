"""F2 results: E10 submit, E11 results view (src/scan/scan-result.service.ts,
scan-results.builder.ts)."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.core.numbers import num_out, to_numeric
from app.core.settings import Settings
from app.core.time import to_js_iso, utcnow
from app.models.scan import Scan, ScanShoe, ScanShoeResult
from app.repositories import catalog as catalog_repo
from app.repositories import scans as scan_repo
from app.repositories import shoes as shoes_repo
from app.repositories.scans import not_found
from app.services.catalog_rules import slugify
from app.services.result_rules import (
    check_raw_payload,
    condition_label_for,
    match_percent,
    normalize_candidates,
    result_status_for,
)
from app.services.review_rules import is_unknown_brand, review_state_for, reviewed_count
from app.services.scan_rules import label_for
from app.services.shoe_views import ShoeViewMapper

log = logging.getLogger("app.results")

SUBMITTABLE: tuple[str, ...] = ("processing", "review")
LOCKED_SHOE_STATUSES: tuple[str, ...] = ("confirmed", "rejected")
T = TypeVar("T")


def assert_accepts_results(scan: Scan) -> None:
    if scan.status in SUBMITTABLE:
        return
    raise ApiError(
        409,
        "NOT_PROCESSING",
        "Scan is still a draft; call /finish before submitting results"
        if scan.status == "draft"
        else f"Scan is {scan.status}; it no longer accepts results",
    )


def assert_result_open(shoe: ScanShoe) -> None:
    if shoe.status not in LOCKED_SHOE_STATUSES:
        return
    raise ApiError(
        409,
        "RESULT_LOCKED",
        f"Shoe is {shoe.status}; its result can no longer be changed",
    )


def to_result_view(row: ScanShoeResult, include_raw: bool) -> dict[str, Any]:
    view: dict[str, Any] = {
        "source": row.source,
        "outcome": row.outcome,
        "modelVersion": row.model_version,
        "brand": row.brand,
        "subBrand": row.sub_brand,
        "model": row.model,
        "colorway": row.colorway,
        "category": row.category,
        "subCategory": row.sub_category,
        "material": row.material,
        "confidence": num_out(row.confidence),
        "matchPercent": match_percent(
            float(row.confidence) if row.confidence is not None else None
        ),
        "condition": {
            "code": row.condition_code,
            "label": condition_label_for(row.condition_code),
        },
        "candidates": row.candidates or [],
    }
    if include_raw:
        view["raw"] = row.raw
    view["submittedAt"] = to_js_iso(row.submitted_at)
    view["updatedAt"] = to_js_iso(row.updated_at)
    return view


class ScanResultsBuilder:
    def __init__(self, views: ShoeViewMapper) -> None:
        self._views = views

    async def build(
        self,
        session: AsyncSession,
        scan: Scan,
        include_raw: bool = False,
        preloaded_shoes: list[ScanShoe] | None = None,
    ) -> dict[str, Any]:
        shoes = preloaded_shoes
        if shoes is None:
            shoes = list(
                (
                    await session.execute(
                        select(ScanShoe)
                        .where(ScanShoe.scan_id == scan.id)
                        .order_by(ScanShoe.position.asc())
                    )
                ).scalars()
            )
        ids = [s.id for s in shoes]
        results = (
            list(
                (
                    await session.execute(
                        select(ScanShoeResult).where(
                            ScanShoeResult.scan_shoe_id.in_(ids)
                        )
                    )
                ).scalars()
            )
            if ids
            else []
        )
        entries = await shoes_repo.entries_for_scan_shoes(session, ids)
        primary_key = await shoes_repo.primary_keys_for(session, entries)
        labels = await shoes_repo.condition_labels(session)
        result_by_shoe = {r.scan_shoe_id: r for r in results}
        entry_by_shoe = {
            e.scan_shoe_id: e for e in entries if e.scan_shoe_id is not None
        }
        unreviewed = [s for s in shoes if review_state_for(s.status) is None]
        needs_suggestion = any(
            (
                result_by_shoe.get(s.id) is not None
                and result_by_shoe[s.id].brand is not None
            )
            for s in unreviewed
        )
        brands = (
            await catalog_repo.brands_by_names(
                session,
                [
                    result_by_shoe[s.id].brand if s.id in result_by_shoe else None
                    for s in unreviewed
                ],
            )
            if needs_suggestion
            else {}
        )
        views: list[dict[str, Any]] = []
        for s in shoes:
            row = result_by_shoe.get(s.id)
            entry = entry_by_shoe.get(s.id)
            predicted = (
                row.brand
                if row is not None and not is_unknown_brand(row.brand)
                else None
            )
            suggested = brands.get(slugify(predicted)) if predicted else None
            my_shoe = None
            if entry is not None:
                key = (
                    primary_key.get(entry.primary_photo_id)
                    if entry.primary_photo_id
                    else None
                )
                my_shoe = await self._views.to_my_shoe_view(entry, key, labels)
            views.append(
                {
                    "shoeId": str(s.id),
                    "position": s.position,
                    "label": label_for(s.position),
                    "status": result_status_for(row.outcome if row else None),
                    "result": to_result_view(row, include_raw) if row else None,
                    "review": review_state_for(s.status),
                    "myShoeId": str(entry.id) if entry else None,
                    "myShoe": my_shoe,
                    "suggested": {
                        "brandId": str(suggested.id) if suggested else None,
                        "brand": suggested.name if suggested else predicted,
                    },
                }
            )
        return {
            "scanId": str(scan.id),
            "status": scan.status,
            "allResolved": len(shoes) > 0
            and all(v["result"] is not None for v in views),
            "reviewed": reviewed_count([s.status for s in shoes]),
            "shoes": views,
        }


class ScanResultService:
    def __init__(self, settings: Settings, builder: ScanResultsBuilder) -> None:
        self._s = settings
        self._builder = builder

    async def submit(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        shoe_id: uuid.UUID,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        outcome = body.get("outcome") or "identified"
        brand = body.get("brand")
        confidence = body.get("confidence")
        if outcome == "identified" and (not brand or confidence is None):
            raise ApiError(
                400,
                "RESULT_INCOMPLETE",
                "An 'identified' result needs both brand and confidence",
                {
                    "missing": ([] if brand else ["brand"])
                    + ([] if confidence is not None else ["confidence"])
                },
            )
        candidates = self._validate_candidates(body.get("candidates") or [])
        self._validate_raw(body.get("raw"))
        fields: dict[str, Any] = {
            "source": "device",
            "outcome": outcome,
            "modelVersion": body["modelVersion"],
            "brand": brand,
            "subBrand": body.get("subBrand"),
            "model": body.get("model"),
            "colorway": body.get("colorway"),
            "category": body.get("category"),
            "subCategory": body.get("subCategory"),
            "material": body.get("material"),
            "confidence": confidence,
            "conditionCode": body.get("conditionCode"),
            "candidates": [c.as_json() for c in candidates],
            "raw": body.get("raw"),
        }

        async def work(s: AsyncSession, scan: Scan) -> dict[str, Any]:
            return await self.write_result(s, scan, shoe_id, fields)

        return await self.in_scan_tx(session, user_id, scan_id, work)

    async def write_result(
        self,
        session: AsyncSession,
        scan: Scan,
        shoe_id: uuid.UUID,
        fields: dict[str, Any],
    ) -> dict[str, Any]:
        shoe = await scan_repo.shoe_in_scan(session, shoe_id, scan.id)
        if shoe is None:
            raise not_found("SHOE_NOT_FOUND", "Shoe not found")
        assert_result_open(shoe)
        existing = (
            await session.execute(
                select(ScanShoeResult).where(ScanShoeResult.scan_shoe_id == shoe.id)
            )
        ).scalar_one_or_none()
        columns = {
            "source": fields["source"],
            "outcome": fields["outcome"],
            "model_version": fields["modelVersion"],
            "brand": fields.get("brand"),
            "sub_brand": fields.get("subBrand"),
            "model": fields.get("model"),
            "colorway": fields.get("colorway"),
            "category": fields.get("category"),
            "sub_category": fields.get("subCategory"),
            "material": fields.get("material"),
            "confidence": to_numeric(fields.get("confidence")),
            "condition_code": fields.get("conditionCode"),
            "candidates": [
                c.as_json() if hasattr(c, "as_json") else c
                for c in fields.get("candidates") or []
            ],
            "raw": fields.get("raw"),
            "submitted_at": utcnow(),
        }
        if existing is not None:
            await session.execute(
                update(ScanShoeResult)
                .where(ScanShoeResult.id == existing.id)
                .values(**columns)
            )
        else:
            await session.execute(
                insert(ScanShoeResult).values(scan_shoe_id=shoe.id, **columns)
            )
        await session.execute(
            update(ScanShoe)
            .where(ScanShoe.id == shoe.id)
            .values(status=fields["outcome"])
        )
        scan_status = await self._advance_if_resolved(session, scan)
        scan_pk, shoe_pk, shoe_position = scan.id, shoe.id, shoe.position
        session.expire_all()  # re-read the row the UPDATE/INSERT just wrote
        saved = (
            await session.execute(
                select(ScanShoeResult).where(ScanShoeResult.scan_shoe_id == shoe_pk)
            )
        ).scalar_one()
        log.info(
            "scan %s shoe %s %s result %s (%s)",
            scan_pk,
            shoe_pk,
            fields["source"],
            fields["outcome"],
            "replaced" if existing else "created",
        )
        return {
            "shoeId": str(shoe_pk),
            "label": label_for(shoe_position),
            "replaced": existing is not None,
            "status": result_status_for(fields["outcome"]),
            "result": to_result_view(saved, True),
            "scanStatus": scan_status,
        }

    async def results(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        include_raw: bool,
    ) -> dict[str, Any]:
        scan = await scan_repo.find_owned_scan(session, user_id, scan_id)
        return await self._builder.build(session, scan, include_raw)

    async def in_scan_tx(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        scan_id: uuid.UUID,
        work: Callable[[AsyncSession, Scan], Awaitable[T]],
    ) -> T:
        scan = await scan_repo.find_owned_scan(session, user_id, scan_id, lock=True)
        assert_accepts_results(scan)
        scan_pk = scan.id  # `work` may expire the identity map
        out = await work(session, scan)
        await scan_repo.touch_scan(session, scan_pk)
        await session.commit()
        return out

    async def _advance_if_resolved(self, session: AsyncSession, scan: Scan) -> str:
        ids = [
            r[0]
            for r in (
                await session.execute(
                    select(ScanShoe.id).where(ScanShoe.scan_id == scan.id)
                )
            ).all()
        ]
        done = (
            int(
                (
                    await session.execute(
                        select(func.count())
                        .select_from(ScanShoeResult)
                        .where(ScanShoeResult.scan_shoe_id.in_(ids))
                    )
                ).scalar_one()
            )
            if ids
            else 0
        )
        if not ids or done < len(ids):
            return str(scan.status)
        if scan.status == "review":
            return "review"
        await session.execute(
            update(Scan).where(Scan.id == scan.id).values(status="review")
        )
        log.info("scan %s moved to review (%d shoe result(s))", scan.id, done)
        return "review"

    def _validate_candidates(self, raw: list[dict[str, Any]]) -> list[Any]:
        decision = normalize_candidates(raw, self._s.SCAN_RESULT_MAX_CANDIDATES)
        if decision.ok:
            return decision.candidates
        raise ApiError(400, decision.error, decision.detail or "")

    def _validate_raw(self, raw: Any) -> None:
        bad = check_raw_payload(raw, self._s.SCAN_RESULT_RAW_MAX_BYTES)
        if bad == "RAW_TOO_LARGE":
            raise ApiError(
                413,
                "RAW_TOO_LARGE",
                f"raw must serialize to at most {self._s.SCAN_RESULT_RAW_MAX_BYTES} bytes",
            )
        if bad == "RAW_TOO_DEEP":
            raise ApiError(
                400, "RAW_TOO_DEEP", "raw is nested too deeply (max 6 levels)"
            )
