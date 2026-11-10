"""F3 review rules (src/scan/review-rules.ts): overlaying the user's answer on
the prediction, review bookkeeping and the static value placeholders."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

REVIEWED: tuple[str, ...] = ("confirmed", "rejected")
REJECT_REQUIRED: tuple[str, ...] = ("brand", "model", "color", "size")


def clean(v: str | None) -> str | None:
    if v is None:
        return None
    t = v.strip()
    return t or None


def pick(body: str | None, fallback: str | None) -> str | None:
    return clean(body) if clean(body) is not None else clean(fallback)


def is_unknown_brand(brand: str | None) -> bool:
    v = clean(brand)
    return v is None or v.lower() == "unknown"


@dataclass(frozen=True)
class Predicted:
    brand: str | None
    model: str | None
    colorway: str | None
    sub_brand: str | None
    category: str | None
    sub_category: str | None
    condition_code: str | None
    material: str | None


@dataclass(frozen=True)
class Answer:
    brand: str | None = None
    model: str | None = None
    color: str | None = None
    size: str | None = None
    gender: str | None = None


@dataclass(frozen=True)
class Identity:
    brand: str | None
    sub_brand: str | None
    category: str | None
    sub_category: str | None
    condition_code: str | None
    material: str | None
    model: str | None
    color: str | None
    size: str | None
    gender: str | None


def overlay_details(predicted: Predicted, body: Answer) -> Identity:
    predicted_brand = (
        None if is_unknown_brand(predicted.brand) else clean(predicted.brand)
    )
    brand = pick(body.brand, predicted_brand)
    body_brand = clean(body.brand)
    brand_changed = body_brand is not None and (
        predicted_brand is None or body_brand.lower() != predicted_brand.lower()
    )
    return Identity(
        brand=brand,
        sub_brand=None if brand_changed else clean(predicted.sub_brand),
        category=clean(predicted.category),
        sub_category=clean(predicted.sub_category),
        condition_code=predicted.condition_code,
        material=clean(predicted.material),
        model=pick(body.model, predicted.model),
        color=pick(body.color, predicted.colorway),
        size=pick(body.size, None),
        gender=body.gender,
    )


def brand_corrected(predicted_brand: str | None, answer_brand: str | None) -> bool:
    p = None if is_unknown_brand(predicted_brand) else clean(predicted_brand)
    a = clean(answer_brand)
    if a is None:
        return False
    return p is None or a.lower() != p.lower()


def review_state_for(status: str) -> str | None:
    return status if status in REVIEWED else None


def reviewed_count(statuses: list[str]) -> dict[str, int]:
    done = sum(1 for s in statuses if s in REVIEWED)
    return {"done": done, "total": len(statuses)}


def is_completed(statuses: list[str]) -> bool:
    c = reviewed_count(statuses)
    return c["total"] > 0 and c["done"] == c["total"]


def missing_fields(mode: str, answer: Answer) -> list[str]:
    if mode == "confirm":
        return []
    values = {
        "brand": answer.brand,
        "model": answer.model,
        "color": answer.color,
        "size": answer.size,
    }
    return [f for f in REJECT_REQUIRED if values[f] is None or values[f].strip() == ""]  # type: ignore[union-attr]


# ─── value placeholders (until ValueLens) ────────────────────────────────────
VALUE_PLACEHOLDERS: tuple[dict[str, Any], ...] = (
    {
        "recommendedAction": "resell",
        "resaleMin": 65,
        "resaleMax": 90,
        "resaleBucket": "from_50_to_100",
        "demandNote": "High demand silhouette",
        "recommendationReason": "Due to high demand and exceptional condition, keeping this pair in circulation maximizes value.",
    },
    {
        "recommendedAction": "repair",
        "resaleMin": 25,
        "resaleMax": 40,
        "resaleBucket": "from_25_to_50",
        "demandNote": None,
        "recommendationReason": "A small repair restores most of the resale value of this pair.",
    },
    {
        "recommendedAction": "resell",
        "resaleMin": 35,
        "resaleMax": 55,
        "resaleBucket": "from_50_to_100",
        "demandNote": "Steady demand",
        "recommendationReason": "Good condition and steady demand make resale the best next step.",
    },
    {
        "recommendedAction": "recycle",
        "resaleMin": None,
        "resaleMax": None,
        "resaleBucket": None,
        "demandNote": None,
        "recommendationReason": "Wear is beyond resale or repair; recycling recovers the materials.",
    },
)


def stable_hash(text: str) -> int:
    """FNV-1a over UTF-16 code units, 32-bit, exactly as the Node version."""
    h = 0x811C9DC5
    for unit in text.encode("utf-16-le")[::2] if text.isascii() else _utf16_units(text):
        h ^= unit
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def _utf16_units(text: str) -> list[int]:
    data = text.encode("utf-16-le")
    return [data[i] | (data[i + 1] << 8) for i in range(0, len(data), 2)]


def placeholder_for(shoe_id: str) -> dict[str, Any]:
    return VALUE_PLACEHOLDERS[stable_hash(shoe_id) % len(VALUE_PLACEHOLDERS)]


def resale_bucket_for(resale_max: float | None) -> str | None:
    if resale_max is None or resale_max != resale_max:
        return None
    if resale_max < 20:
        return "under_20"
    if resale_max <= 50:
        return "from_25_to_50"
    if resale_max <= 100:
        return "from_50_to_100"
    return "over_100"
