"""Pure catalog rules (src/catalog/catalog-rules.ts): slugs, sizes, model
clean-up, taxonomy and product import plans, shoe-type mapping. No I/O, so
every function is property-tested."""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from app.core.constants import GENDERS

# ─── slug / title ────────────────────────────────────────────────────────────
_COMBINING = re.compile(r"[̀-ͯ]")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    s = unicodedata.normalize("NFKD", text or "")
    s = _COMBINING.sub("", s).lower()
    s = _NON_ALNUM.sub("-", s)
    return s.strip("-")


KEEP_UPPER = frozenset({"apl", "dc", "ecco", "hoka", "k-swiss", "on"})


def title_case(slug_or_name: str) -> str:
    words = re.split(r"\s+", re.sub(r"[_-]+", " ", (slug_or_name or "").strip()))
    out: list[str] = []
    for w in words:
        if not w:
            continue
        lower = w.lower()
        out.append(
            lower.upper() if lower in KEEP_UPPER else lower[:1].upper() + lower[1:]
        )
    return " ".join(out)


# ─── sizes ───────────────────────────────────────────────────────────────────
_WIDTH = re.compile(r"\b(wide|narrow|medium|regular|x-wide|xw|w|m|d|b|ee|e)\b\.?$")
_PREFIX = re.compile(r"^(us|size)\s*:?\s*")
_SIZE = re.compile(r"^(\d{1,2})(?:\.(5|0))?$")


def normalize_size(raw: str | None) -> str | None:
    if not raw:
        return None
    s = raw.strip().lower()
    s = _WIDTH.sub("", s)
    s = _PREFIX.sub("", s).strip()
    m = _SIZE.match(s)
    if not m:
        return None
    whole = int(m.group(1))
    half = m.group(2) == "5"
    if whole < 1 or whole > 20:
        return None
    return f"{whole}.5" if half else str(whole)


MAX_SAFE_INTEGER = 9007199254740991


def size_sort_key(label: str) -> int:
    """`Number(label)` rounded to tenths, or MAX_SAFE_INTEGER for non-numbers."""
    try:
        n = float(label.strip()) if label.strip() != "" else 0.0
    except ValueError:
        return MAX_SAFE_INTEGER
    if not math.isfinite(n):
        return MAX_SAFE_INTEGER
    return int(math.floor(n * 10 + 0.5))


def size_order(labels: Iterable[str]) -> list[str]:
    return sorted(
        set(labels), key=lambda label: (size_sort_key(label), locale_key(label))
    )


def generic_us_sizes() -> list[str]:
    out: list[str] = []
    for n in range(4, 16):
        out.append(str(n))
        if n < 15:
            out.append(f"{n}.5")
    return out


def locale_key(s: str) -> tuple[str, str]:
    """Approximates `String.prototype.localeCompare` (ICU root): letters compare
    case-insensitively first, punctuation is secondary, then the raw string."""
    primary = re.sub(r"[^0-9a-z]+", "", s.casefold())
    return (primary, s.swapcase())


# ─── model clean-up ──────────────────────────────────────────────────────────
_SIZE_SEGMENT = re.compile(
    r"^\d{1,2}(\.5)?(\s*-\s*\d{1,2}(\.5)?)?\s*(wide|narrow|medium|regular|w|m|d|b|x-wide)?$"
)
_SIZE_WORD = re.compile(r"^(x?s|m|l|xl|xxl|one size|medium|wide|narrow)$")


def clean_model(
    model: str | None, colour: str | None, size_raw: str | None
) -> str | None:
    base = (model or "").strip()
    if not base:
        return None
    parts = re.split(r"\s+-\s+", base)
    col = (colour or "").strip().lower()
    raw = (size_raw or "").strip().lower()
    while len(parts) > 1:
        last = parts[-1].strip()
        lower = last.lower()
        is_colour = col != "" and lower == col
        is_size = (
            lower == raw
            or normalize_size(last) is not None
            or bool(_SIZE_SEGMENT.match(lower))
            or bool(_SIZE_WORD.match(lower))
        )
        if not is_colour and not is_size:
            break
        parts.pop()
    return " - ".join(parts).strip() or base


def normalize_gender(raw: str | None) -> str | None:
    v = (raw or "").strip().lower()
    if v in ("male", "mens"):
        return "men"
    if v in ("female", "womens"):
        return "women"
    return v if v in GENDERS else None


# ─── taxonomy import ─────────────────────────────────────────────────────────
@dataclass(frozen=True)
class TaxonomyRow:
    category: str | None
    subcategory: str | None
    brand: str | None


@dataclass
class ImportPlan:
    categories: list[dict[str, str]]
    subcategories: list[dict[str, str]]
    brands: list[dict[str, str]]
    links: list[dict[str, str]]
    skipped: int


def import_taxonomy(rows: Sequence[TaxonomyRow | Mapping[str, Any]]) -> ImportPlan:
    categories: dict[str, str] = {}
    subcategories: dict[str, dict[str, str]] = {}
    brands: dict[str, str] = {}
    links: dict[str, dict[str, str]] = {}
    skipped = 0
    for r in rows:
        row = (
            r
            if isinstance(r, TaxonomyRow)
            else TaxonomyRow(r.get("category"), r.get("subcategory"), r.get("brand"))
        )
        category_slug = slugify(row.category or "")
        brand_slug = slugify(row.brand or "")
        if not category_slug or not brand_slug:
            skipped += 1
            continue
        categories[category_slug] = title_case(category_slug)
        brands[brand_slug] = title_case(brand_slug)
        sub_slug = slugify(row.subcategory or "")
        if sub_slug:
            key = f"{category_slug}/{sub_slug}"
            subcategories[key] = {
                "categorySlug": category_slug,
                "slug": sub_slug,
                "name": title_case(sub_slug),
            }
            links[f"{brand_slug}|{key}"] = {
                "brandSlug": brand_slug,
                "categorySlug": category_slug,
                "subcategorySlug": sub_slug,
            }
    return ImportPlan(
        categories=sorted(
            ({"slug": s, "name": n} for s, n in categories.items()),
            key=lambda c: locale_key(c["slug"]),
        ),
        subcategories=sorted(
            subcategories.values(),
            key=lambda s: (locale_key(s["categorySlug"]), locale_key(s["slug"])),
        ),
        brands=sorted(
            ({"slug": s, "name": n} for s, n in brands.items()),
            key=lambda b: locale_key(b["slug"]),
        ),
        links=sorted(
            links.values(),
            key=lambda link: (
                locale_key(link["brandSlug"]),
                locale_key(link["categorySlug"]),
                locale_key(link["subcategorySlug"]),
            ),
        ),
        skipped=skipped,
    )


# ─── product import ──────────────────────────────────────────────────────────
def clip(v: str | None, max_len: int) -> str | None:
    t = (v or "").strip()
    return None if t == "" else t[:max_len]


def _msrp(v: Any) -> float | None:
    if v is None:
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def import_products(
    rows: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    """Row → upsert dict keyed by sku (later duplicates win); unusable rows skipped."""
    out: dict[str, dict[str, Any]] = {}
    skipped = 0
    for r in rows:
        sku = clip(r.get("sku"), 40)
        brand_slug = slugify(r.get("brand") or "")
        if not sku or not brand_slug:
            skipped += 1
            continue
        release = r.get("releaseDate")
        out[sku] = {
            "sku": sku,
            "brandSlug": brand_slug,
            "model": clip(
                clean_model(r.get("model"), r.get("colour"), r.get("size")), 200
            ),
            "modelCode": clip(r.get("modelCode"), 100),
            "category": clip(r.get("category"), 100),
            "subCategory": clip(r.get("subCategory"), 100),
            "silhouette": clip(r.get("silhouette"), 100),
            "gender": normalize_gender(r.get("gender")),
            "colour": clip(r.get("colour"), 200),
            "size": normalize_size(r.get("size")),
            "sizeRaw": clip(r.get("size"), 120),
            "msrp": _msrp(r.get("msrp")),
            "releaseDate": clip(str(release) if release is not None else None, 10),
            "title": clip(r.get("title"), 500),
        }
    return list(out.values()), skipped


def sizes_by_brand(products: Iterable[Mapping[str, Any]]) -> dict[str, list[str]]:
    acc: dict[str, set[str]] = {}
    for p in products:
        size = p.get("size")
        if not size:
            continue
        acc.setdefault(str(p["brandSlug"]), set()).add(str(size))
    return {k: size_order(v) for k, v in acc.items()}


# ─── F5-D20: product-DB category → shoe type ────────────────────────────────
SHOE_TYPE_SLUGS: tuple[str, ...] = (
    "athletic-shoes",
    "casual-shoes",
    "dress-shoes",
    "boots",
    "sandals",
    "slippers",
)

SHOE_TYPE_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("boots", ("boot", "bootie", "chelsea")),
    ("slippers", ("slipper", "mule", "clog", "house")),
    ("sandals", ("sandal", "slide", "flip", "flop", "thong", "espadrille")),
    (
        "dress-shoes",
        (
            "dress",
            "oxford",
            "derby",
            "loafer",
            "brogue",
            "pump",
            "heel",
            "wedge",
            "platform",
            "formal",
            "monk",
        ),
    ),
    (
        "athletic-shoes",
        (
            "athletic",
            "running",
            "run",
            "workout",
            "training",
            "hiking",
            "sneaker",
            "trainer",
            "sport",
            "basketball",
            "tennis",
            "golf",
            "soccer",
            "football",
            "walking",
            "trail",
            "cross",
            "fitness",
            "gym",
            "track",
            "cleat",
            "skate",
            "cycling",
        ),
    ),
    (
        "casual-shoes",
        (
            "casual",
            "fashion",
            "flat",
            "ballet",
            "boat",
            "deck",
            "canvas",
            "lifestyle",
            "everyday",
            "shoe",
        ),
    ),
)


def shoe_type_for(category_slug_or_name: str | None) -> str | None:
    text = slugify(category_slug_or_name or "")
    if not text:
        return None
    tokens: set[str] = set()
    for t in text.split("-"):
        if not t:
            continue
        tokens.add(re.sub(r"s$", "", t) if len(t) > 3 and not t.endswith("ss") else t)
    for type_slug, words in SHOE_TYPE_KEYWORDS:
        if any(w in tokens for w in words):
            return type_slug
    return None
