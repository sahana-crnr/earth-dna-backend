"""Catalog rule properties, ported from src/catalog/catalog-rules.pbt.spec.ts."""

from __future__ import annotations

import re

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.services.catalog_rules import (
    clean_model,
    generic_us_sizes,
    import_products,
    import_taxonomy,
    normalize_gender,
    normalize_size,
    shoe_type_for,
    size_order,
    size_sort_key,
    sizes_by_brand,
    slugify,
    title_case,
)

SLUG = re.compile(r"^([a-z0-9]+(-[a-z0-9]+)*)?$")


@settings(max_examples=300)
@given(st.text(max_size=40))
def test_slug_shape_and_idempotent(s: str) -> None:
    slug = slugify(s)
    assert SLUG.match(slug)
    assert slugify(slug) == slug


def test_slug_and_title_pinned() -> None:
    assert slugify("On Running") == "on-running"
    assert slugify("361°") == "361"
    assert slugify("new_balance") == "new-balance"
    assert slugify("Café Noir") == "cafe-noir"
    assert title_case("new_balance") == "New Balance"
    assert title_case("on") == "ON"
    assert title_case("athletic_shoes") == "Athletic Shoes"
    assert title_case("k-swiss") == "K Swiss"  # split on "-" first, as Node does


# ─── F3-P8 sizes ─────────────────────────────────────────────────────────────
@settings(max_examples=300)
@given(
    st.integers(min_value=1, max_value=20),
    st.booleans(),
    st.sampled_from(["", " wide", " W", " Narrow", " D", " medium", " EE", " m."]),
    st.sampled_from(["", "US ", "us: ", "Size "]),
)
def test_normalize_size_accepts_whole_and_half(
    n: int, half: bool, width: str, prefix: str
) -> None:
    label = f"{n}.5" if half else str(n)
    assert normalize_size(f"{prefix}{label}{width}") == label


@pytest.mark.parametrize(
    "bad", ["", "0", "21", "7.25", "abc", "7 1/2", None, "100", "7.9"]
)
def test_normalize_size_rejects(bad: str | None) -> None:
    assert normalize_size(bad) is None


def test_normalize_size_pinned() -> None:
    assert normalize_size("US 7.5") == "7.5"
    assert normalize_size("8.0") == "8"


@settings(max_examples=200)
@given(
    st.lists(
        st.sampled_from([*generic_us_sizes(), "XL", "one size", "2.5", "20"]),
        max_size=20,
    )
)
def test_size_order_numeric_dedup_stable(labels: list[str]) -> None:
    out = size_order(labels)
    assert len(out) == len(set(out)) and set(out) == set(labels)
    keys = [size_sort_key(x) for x in out]
    assert keys == sorted(keys)
    assert size_order(out) == out


def test_generic_us_sizes() -> None:
    g = generic_us_sizes()
    assert g[0] == "4" and g[-1] == "15" and len(g) == 23
    assert size_order(g) == g


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("Male", "men"),
        ("mens", "men"),
        ("FEMALE", "women"),
        ("womens", "women"),
        ("kids", "kids"),
        ("unisex", "unisex"),
        ("boys", None),
        ("", None),
        (None, None),
    ],
)
def test_normalize_gender(raw: str | None, want: str | None) -> None:
    assert normalize_gender(raw) == want


# ─── F3-P6 taxonomy ──────────────────────────────────────────────────────────
tax_rows = st.lists(
    st.fixed_dictionaries(
        {
            "category": st.one_of(
                st.none(),
                st.sampled_from(["Athletic Shoes", "boots", "", "Sandals & Slides"]),
            ),
            "subcategory": st.one_of(
                st.none(), st.sampled_from(["Running", "Trail", "", "Chelsea"])
            ),
            "brand": st.one_of(
                st.none(),
                st.sampled_from(["Nike", "on running", "", "361°", "New_Balance"]),
            ),
        }
    ),
    max_size=30,
)


@settings(max_examples=200)
@given(tax_rows)
def test_import_taxonomy_unique_complete_idempotent(
    rows: list[dict[str, str | None]],
) -> None:
    plan = import_taxonomy(rows)
    usable = [
        r for r in rows if slugify(r["category"] or "") and slugify(r["brand"] or "")
    ]
    assert plan.skipped == len(rows) - len(usable)
    assert len({c["slug"] for c in plan.categories}) == len(plan.categories)
    assert len({b["slug"] for b in plan.brands}) == len(plan.brands)
    assert {slugify(r["category"] or "") for r in usable} == {
        c["slug"] for c in plan.categories
    }
    assert {slugify(r["brand"] or "") for r in usable} == {
        b["slug"] for b in plan.brands
    }
    # re-importing the plan as rows yields the same plan
    again_rows = [
        {
            "category": link["categorySlug"],
            "subcategory": link["subcategorySlug"],
            "brand": link["brandSlug"],
        }
        for link in plan.links
    ] + [
        {"category": c["slug"], "subcategory": None, "brand": plan.brands[0]["slug"]}
        for c in plan.categories
        if plan.brands
    ]
    again = import_taxonomy(again_rows)
    assert again.links == plan.links
    assert {c["slug"] for c in again.categories} == {c["slug"] for c in plan.categories}


# ─── cleanModel ──────────────────────────────────────────────────────────────
def test_clean_model_pinned() -> None:
    assert (
        clean_model("Ultraboost 22 - Core Black", "Core Black", "9") == "Ultraboost 22"
    )
    assert clean_model("Air Max 90 - 10 Wide", None, "10 Wide") == "Air Max 90"
    assert clean_model("Chuck Taylor - Hi", "White", "8") == "Chuck Taylor - Hi"
    assert clean_model(" - 9.5", None, "9.5") == "- 9.5"
    assert clean_model("", "x", "y") is None
    assert clean_model(None, None, None) is None


@settings(max_examples=200)
@given(
    st.text(max_size=30),
    st.one_of(st.none(), st.text(max_size=10)),
    st.one_of(st.none(), st.sampled_from(["9", "10 Wide", "XL", "7.5"])),
)
def test_clean_model_idempotent_not_longer(
    m: str, c: str | None, s: str | None
) -> None:
    once = clean_model(m, c, s)
    if m.strip() == "":
        assert once is None
        return
    assert once is not None and once != ""
    assert len(once) <= len(m.strip())
    assert clean_model(once, c, s) == once


# ─── importProducts / sizesByBrand ───────────────────────────────────────────
def test_import_products_last_row_wins_and_normalises() -> None:
    rows = [
        {
            "sku": "A1",
            "brand": "Nike",
            "model": "Air Max 90 - 10 Wide",
            "size": "10 Wide",
            "gender": "Mens",
            "msrp": "129.99",
            "colour": " Black ",
        },
        {
            "sku": "A1",
            "brand": "Nike",
            "model": "Air Max 90",
            "size": "US 9",
            "gender": "x",
            "msrp": None,
        },
        {"sku": "", "brand": "Nike"},
        {"sku": "B2", "brand": "", "model": "x"},
        {
            "sku": "C3",
            "brand": "361°",
            "size": "7.5",
            "msrp": "nan",
            "releaseDate": "2026-01-02T00:00:00Z",
        },
    ]
    products, skipped = import_products(rows)
    assert skipped == 2
    by = {p["sku"]: p for p in products}
    assert (
        by["A1"]["size"] == "9"
        and by["A1"]["gender"] is None
        and by["A1"]["msrp"] is None
    )
    assert by["A1"]["model"] == "Air Max 90" and by["A1"]["sizeRaw"] == "US 9"
    assert by["C3"]["brandSlug"] == "361" and by["C3"]["msrp"] is None
    assert by["C3"]["releaseDate"] == "2026-01-02"
    assert sizes_by_brand(products) == {"nike": ["9"], "361": ["7.5"]}


# ─── F5-D20 shoeTypeFor ──────────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("inp", "want"),
    [
        ("Running Shoes", "athletic-shoes"),
        ("boots", "boots"),
        ("Chelsea Boots", "boots"),
        ("Slides", "sandals"),
        ("Loafers", "dress-shoes"),
        ("Fashion Sneakers", "athletic-shoes"),
        ("Clogs & Mules", "slippers"),
        ("workout", "athletic-shoes"),
        ("platform", "dress-shoes"),
        ("network", None),
        ("", None),
        (None, None),
        ("Dress", "dress-shoes"),
        ("Flats", "casual-shoes"),
    ],
)
def test_shoe_type_for(inp: str | None, want: str | None) -> None:
    assert shoe_type_for(inp) == want


@settings(max_examples=200)
@given(
    st.text(
        alphabet="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
        min_size=4,
        max_size=12,
    )
)
def test_shoe_type_never_matches_inside_a_word(word: str) -> None:
    # a single token only matches when it is itself (or its singular) a keyword
    out = shoe_type_for(word)
    token = slugify(word)
    if out is not None and token:
        from app.services.catalog_rules import SHOE_TYPE_KEYWORDS

        stem = (
            re.sub(r"s$", "", token)
            if len(token) > 3 and not token.endswith("ss")
            else token
        )
        assert any(stem in words for _, words in SHOE_TYPE_KEYWORDS)
