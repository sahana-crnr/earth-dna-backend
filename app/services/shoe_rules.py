"""F4 to F7 pure rules: list filters and summary (src/shoes/shoes-rules.ts),
share tokens (share-rules.ts), profile materials, condition view, photo
ordering and the edit overlay (shoe-profile-rules.ts)."""

from __future__ import annotations

import re
import secrets
import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any

from app.core.constants import CONDITION_CODES
from app.core.numbers import js_round
from app.services.catalog_rules import slugify
from app.services.result_rules import CONDITION_LABELS

MATERIAL_PARTS: tuple[str, ...] = ("upper", "midsole", "outsole", "laces")


# ─── list filters and summary ────────────────────────────────────────────────
def condition_slug(label: str) -> str:
    return re.sub(r"^_+|_+$", "", re.sub(r"[^a-z0-9]+", "_", label.strip().lower()))


CONDITION_FILTER_CODES: dict[str, list[str]] = {}
for _code in CONDITION_CODES:
    CONDITION_FILTER_CODES.setdefault(
        condition_slug(CONDITION_LABELS[_code]), []
    ).append(_code)
CONDITION_FILTERS: tuple[str, ...] = tuple(CONDITION_FILTER_CODES)


def codes_for_conditions(slugs: Iterable[str]) -> list[str]:
    wanted: set[str] = set()
    for s in slugs:
        wanted.update(CONDITION_FILTER_CODES.get(s, []))
    return [c for c in CONDITION_CODES if c in wanted]


def split_multi(value: Any) -> Any:
    """`a,b` or repeated params → unique trimmed list; anything else untouched."""
    if value is None:
        return value
    parts = value if isinstance(value, list) else [value]
    if not all(isinstance(p, str) for p in parts):
        return value
    out: list[str] = []
    for p in parts:
        for piece in p.split(","):
            t = piece.strip()
            if t and t not in out:
                out.append(t)
    return out


def _num(v: Any) -> float:
    if v is None:
        return 0.0
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f == f else 0.0


def _round2(n: float) -> float:
    return js_round(n * 100) / 100


def to_summary(
    pairs: Any, value_count: Any, value_min: Any, value_max: Any
) -> dict[str, Any]:
    from app.core.numbers import num_out

    count = _num(value_count)
    return {
        "pairsScanned": num_out(_num(pairs)),
        "potentialValue": (
            {
                "min": num_out(_round2(_num(value_min))),
                "max": num_out(_round2(_num(value_max))),
                "currency": "USD",
            }
            if count > 0
            else None
        ),
    }


# ─── share tokens ────────────────────────────────────────────────────────────
TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # noqa: S105
TOKEN_MAX_LENGTH = 64
SLUG_MAX_LENGTH = 40
_TOKEN_RE = re.compile(r"^[a-z0-9-]{1,64}$")
TOKEN_RANDOM_CHARS_DEFAULT = 12


def random_part(random_chars: int, pick: Callable[[int], int] | None = None) -> str:
    choose = pick or (lambda n: secrets.randbelow(n))
    out = []
    for _ in range(random_chars):
        idx = choose(len(TOKEN_ALPHABET))
        out.append(TOKEN_ALPHABET[min(max(0, idx), len(TOKEN_ALPHABET) - 1)])
    return "".join(out)


def make_token(model: str | None, brand: str | None, random: str) -> str:
    base = slugify(model or "") or slugify(brand or "") or "shoe"
    room = min(SLUG_MAX_LENGTH, TOKEN_MAX_LENGTH - len(random) - 1)
    slug = re.sub(r"-+$", "", base[: max(1, room)]) or "shoe"
    return f"{slug}-{random}"


def is_valid_token(v: Any) -> bool:
    return isinstance(v, str) and bool(_TOKEN_RE.match(v))


def share_url(base: str, token: str) -> str:
    return f"{base.rstrip('/')}/s/{token}"


# ─── profile: materials and condition ────────────────────────────────────────
MATERIALS: dict[str, dict[str, str]] = {
    "athletic-shoes": {
        "upper": "Mesh / Synthetic Leather",
        "midsole": "Air-Sole Cushioning / EVA",
        "outsole": "Rubber Waffle (75% natural)",
        "laces": "Recycled Polyester",
    },
    "casual-shoes": {
        "upper": "Canvas / Leather",
        "midsole": "EVA Foam",
        "outsole": "Vulcanised Rubber",
        "laces": "Cotton",
    },
    "dress-shoes": {
        "upper": "Full-grain Leather",
        "midsole": "Leather Welt",
        "outsole": "Leather / Rubber Heel",
        "laces": "Waxed Cotton",
    },
    "boots": {
        "upper": "Leather / Nubuck",
        "midsole": "PU Foam",
        "outsole": "Lugged Rubber",
        "laces": "Nylon",
    },
    "sandals": {
        "upper": "Synthetic Straps",
        "midsole": "EVA Footbed",
        "outsole": "Rubber",
        "laces": "None",
    },
    "slippers": {
        "upper": "Fleece / Wool",
        "midsole": "Memory Foam",
        "outsole": "TPR",
        "laces": "None",
    },
}


def materials_for(shoe_type_slug: str | None) -> list[dict[str, str]]:
    table = MATERIALS.get(shoe_type_slug or "", MATERIALS["athletic-shoes"])
    return [
        {"part": p, "material": table[p], "source": "static"} for p in MATERIAL_PARTS
    ]


def condition_view_for(code: str | None, mappings: Sequence[Any]) -> dict[str, Any]:
    row = next((m for m in mappings if code and m.code == code), None)
    return {
        "code": code,
        "grade": row.grade_letter if row else None,
        "label": row.label if row else None,
        "description": row.description if row else None,
        "filterGroup": row.filter_group if row else None,
    }


# ─── photos ──────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class PhotoRef:
    id: str
    sort_order: int
    created_at: datetime


def next_primary(photos: Sequence[PhotoRef], removed_id: str | None) -> str | None:
    rest = [p for p in photos if p.id != removed_id]
    if not rest:
        return None
    rest.sort(key=lambda p: (p.sort_order, p.created_at.timestamp(), p.id))
    return rest[0].id


def can_delete_photo(photo_count: int) -> bool:
    return photo_count > 1


def next_sort_order(photos: Iterable[Any]) -> int:
    best = 0
    for p in photos:
        best = max(best, p.sort_order + 1)
    return best


def pick_primary(rows: Sequence[tuple[str, str | None]], preferred: str) -> str | None:
    """rows = (id, view); preferred view, else any view, else the first."""
    for pid, view in rows:
        if view == preferred:
            return pid
    for pid, view in rows:
        if view is not None:
            return pid
    return rows[0][0] if rows else None


# ─── edit overlay ────────────────────────────────────────────────────────────
_UNSET: Any = object()


@dataclass(frozen=True)
class EditableShoe:
    brand_id: uuid.UUID | None
    brand: str
    model: str | None
    colorway: str | None
    size_id: uuid.UUID | None
    size: str | None
    shoe_type_id: uuid.UUID | None
    shoe_type: str | None
    gender: str | None
    action_taken: str
    action_taken_at: datetime | None
    primary_photo_id: uuid.UUID | None


@dataclass
class EditInput:
    brand_id: Any = _UNSET
    brand: Any = _UNSET
    model: Any = _UNSET
    color: Any = _UNSET
    size_id: Any = _UNSET
    size: Any = _UNSET
    shoe_type_id: Any = _UNSET
    shoe_type: Any = _UNSET
    gender: Any = _UNSET
    action_taken: Any = _UNSET
    primary_photo_id: Any = _UNSET


@dataclass
class EditResult:
    next: EditableShoe
    changed: set[str] = field(default_factory=set)
    rematch: bool = False
    revalue: bool = False


def _clean(v: Any) -> str | None:
    if v is None or v is _UNSET:
        return None
    t = str(v).strip()
    return t or None


def apply_edit(shoe: EditableShoe, inp: EditInput, now: datetime) -> EditResult:
    nxt = shoe
    changed: set[str] = set()

    def set_(obj: EditableShoe, k: str, v: Any) -> EditableShoe:
        nonlocal changed
        if getattr(obj, k) != v:
            changed.add(k)
            return replace(obj, **{k: v})
        return obj

    if inp.brand_id is not _UNSET and inp.brand is not _UNSET:
        name = _clean(inp.brand)
        if name:
            nxt = set_(nxt, "brand_id", inp.brand_id)
            nxt = set_(nxt, "brand", name)
    if inp.model is not _UNSET:
        nxt = set_(nxt, "model", _clean(inp.model))
    if inp.color is not _UNSET:
        nxt = set_(nxt, "colorway", _clean(inp.color))
    if inp.size_id is not _UNSET and inp.size is not _UNSET:
        nxt = set_(nxt, "size_id", inp.size_id)
        nxt = set_(nxt, "size", _clean(inp.size))
    if inp.shoe_type_id is not _UNSET and inp.shoe_type is not _UNSET:
        nxt = set_(nxt, "shoe_type_id", inp.shoe_type_id)
        nxt = set_(nxt, "shoe_type", _clean(inp.shoe_type))
    if inp.gender is not _UNSET:
        nxt = set_(nxt, "gender", inp.gender)
    if inp.action_taken is not _UNSET:
        before = nxt.action_taken
        nxt = set_(nxt, "action_taken", inp.action_taken)
        if before != inp.action_taken:
            nxt = set_(
                nxt, "action_taken_at", None if inp.action_taken == "none" else now
            )
    if inp.primary_photo_id is not _UNSET:
        nxt = set_(nxt, "primary_photo_id", inp.primary_photo_id)
    rematch = bool(changed & {"brand", "model", "colorway", "size"})
    return EditResult(
        next=nxt, changed=changed, rematch=rematch, revalue="brand" in changed
    )
