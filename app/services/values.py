"""Shoe value provider (src/shoes/value): the static placeholder until ValueLens."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from app.services.review_rules import placeholder_for


@dataclass(frozen=True)
class ShoeValue:
    recommended_action: str | None
    resale_min: float | None
    resale_max: float | None
    resale_bucket: str | None
    demand_note: str | None
    recommendation_reason: str | None
    source: str
    version: str | None

    def as_columns(self, computed_at: Any) -> dict[str, Any]:
        return {
            "recommended_action": self.recommended_action,
            "resale_min": self.resale_min,
            "resale_max": self.resale_max,
            "resale_bucket": self.resale_bucket,
            "demand_note": self.demand_note,
            "recommendation_reason": self.recommendation_reason,
            "value_source": self.source,
            "value_source_version": self.version,
            "value_computed_at": computed_at,
        }


class ShoeValueProvider(Protocol):
    async def value_for(
        self,
        shoe_id: str,
        brand: str | None,
        model: str | None,
        condition_code: str | None,
    ) -> ShoeValue: ...


class StaticValueProvider:
    async def value_for(
        self,
        shoe_id: str,
        brand: str | None,
        model: str | None,
        condition_code: str | None,
    ) -> ShoeValue:
        p = placeholder_for(shoe_id)
        return ShoeValue(
            recommended_action=p["recommendedAction"],
            resale_min=p["resaleMin"],
            resale_max=p["resaleMax"],
            resale_bucket=p["resaleBucket"],
            demand_note=p["demandNote"],
            recommendation_reason=p["recommendationReason"],
            source="static",
            version=None,
        )
