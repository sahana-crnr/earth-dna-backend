"""`MyShoeView` (src/shoes/shoe-view.mapper.ts): the card used by My Shoes and
the review results."""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

from app.core.numbers import num_out
from app.core.settings import Settings
from app.core.time import to_js_iso
from app.models.shoe import Shoe
from app.services.result_rules import condition_label_for
from app.services.storage import PhotoStorage, sign_or_null


class ShoeViewMapper:
    def __init__(self, settings: Settings, storage: PhotoStorage) -> None:
        self._storage = storage
        self._ttl = settings.SCAN_PHOTO_URL_TTL_SECONDS

    async def to_my_shoe_view(
        self,
        e: Shoe,
        primary_key: str | None,
        labels: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        labels = labels or {}
        code = e.condition_code
        return {
            "id": str(e.id),
            "brand": {"id": _s(e.brand_id), "name": e.brand},
            "subBrand": e.sub_brand,
            "category": e.category,
            "subCategory": e.sub_category,
            "model": e.model,
            "color": e.colorway,
            "size": {"id": _s(e.size_id), "label": e.size},
            "gender": e.gender,
            "shoeType": {"id": _s(e.shoe_type_id), "name": e.shoe_type},
            "condition": {
                "code": code,
                "label": (labels.get(code) if code else None)
                or condition_label_for(code),
            },
            "material": e.material,
            "recommendedAction": e.recommended_action,
            "resale": {
                "min": num_out(e.resale_min),
                "max": num_out(e.resale_max),
                "currency": e.resale_currency,
            },
            "valueSource": e.value_source,
            "thumbnailUrl": await sign_or_null(self._storage, primary_key, self._ttl)
            if primary_key
            else None,
            "primaryPhotoId": _s(e.primary_photo_id),
            "createdAt": to_js_iso(e.created_at),
        }


def _s(v: uuid.UUID | None) -> str | None:
    return str(v) if v is not None else None
