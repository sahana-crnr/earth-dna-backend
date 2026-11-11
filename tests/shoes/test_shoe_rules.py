"""F4–F7 rule properties, ported from shoe-profile-rules.pbt and shoes-rules."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from hypothesis import given, settings
from hypothesis import strategies as st

from app.core.constants import CONDITION_CODES
from app.services.share_page import render_share_html, share_description, value_text
from app.services.shoe_rules import (
    CONDITION_FILTERS,
    MATERIAL_PARTS,
    EditableShoe,
    EditInput,
    PhotoRef,
    apply_edit,
    can_delete_photo,
    codes_for_conditions,
    condition_view_for,
    is_valid_token,
    make_token,
    materials_for,
    next_primary,
    next_sort_order,
    random_part,
    share_url,
    split_multi,
    to_summary,
)

NOW = datetime(2026, 11, 10, tzinfo=UTC)


def _shoe(**over: object) -> EditableShoe:
    base = dict(
        brand_id=uuid.uuid4(),
        brand="Nike",
        model="Air",
        colorway="Black",
        size_id=None,
        size=None,
        shoe_type_id=None,
        shoe_type=None,
        gender=None,
        action_taken="none",
        action_taken_at=None,
        primary_photo_id=None,
    )
    base.update(over)
    return EditableShoe(**base)  # type: ignore[arg-type]


# ─── F5-P1 applyEdit ─────────────────────────────────────────────────────────
def test_apply_edit_untouched_and_changed() -> None:
    s = _shoe()
    r = apply_edit(s, EditInput(), NOW)
    assert r.next == s and r.changed == set() and not r.rematch and not r.revalue
    r = apply_edit(s, EditInput(model="  Air Max 95 ", color=None), NOW)
    assert r.next.model == "Air Max 95" and r.next.colorway is None
    assert r.changed == {"model", "colorway"} and r.rematch and not r.revalue
    bid = uuid.uuid4()
    r = apply_edit(s, EditInput(brand_id=bid, brand="Adidas"), NOW)
    assert r.next.brand == "Adidas" and r.revalue and r.rematch
    blank = apply_edit(s, EditInput(brand_id=bid, brand="  "), NOW)
    assert blank.next.brand == "Nike" and blank.changed == set()


def test_action_taken_stamps() -> None:
    s = _shoe()
    r = apply_edit(s, EditInput(action_taken="resold"), NOW)
    assert r.next.action_taken == "resold" and r.next.action_taken_at == NOW
    back = apply_edit(r.next, EditInput(action_taken="none"), NOW + timedelta(days=1))
    assert back.next.action_taken_at is None
    same = apply_edit(r.next, EditInput(action_taken="resold"), NOW + timedelta(days=1))
    assert same.next.action_taken_at == NOW and same.changed == set()


# ─── F5-P3 photos ────────────────────────────────────────────────────────────
@given(
    st.lists(
        st.tuples(
            st.uuids(),
            st.integers(min_value=0, max_value=5),
            st.integers(min_value=0, max_value=100),
        ),
        min_size=1,
        max_size=6,
        unique_by=lambda t: t[0],
    )
)
def test_next_primary_lowest_sort_order(rows: list[tuple[uuid.UUID, int, int]]) -> None:
    photos = [PhotoRef(str(i), so, NOW + timedelta(seconds=sec)) for i, so, sec in rows]
    removed = photos[0].id
    nxt = next_primary(photos, removed)
    rest = [p for p in photos if p.id != removed]
    if not rest:
        assert nxt is None
    else:
        best = min(rest, key=lambda p: (p.sort_order, p.created_at, p.id))
        assert nxt == best.id
    assert can_delete_photo(len(photos)) is (len(photos) > 1)
    assert all(next_sort_order(photos) > p.sort_order for p in photos)


# ─── F5-P4 materials / condition ─────────────────────────────────────────────
@given(
    st.one_of(
        st.none(),
        st.text(max_size=12),
        st.sampled_from(
            ["boots", "sandals", "slippers", "dress-shoes", "casual-shoes"]
        ),
    )
)
def test_materials_total(slug: str | None) -> None:
    rows = materials_for(slug)
    assert [r["part"] for r in rows] == list(MATERIAL_PARTS)
    assert all(r["source"] == "static" and r["material"] for r in rows)


def test_condition_view_total() -> None:
    class Row:
        def __init__(self, code: str) -> None:
            (
                self.code,
                self.label,
                self.grade_letter,
                self.description,
                self.filter_group,
            ) = code, "L", "A", "D", "Great"

    rows = [Row("C1")]
    assert condition_view_for("C1", rows) == {
        "code": "C1",
        "grade": "A",
        "label": "L",
        "description": "D",
        "filterGroup": "Great",
    }
    assert condition_view_for("C9", rows) == {
        "code": "C9",
        "grade": None,
        "label": None,
        "description": None,
        "filterGroup": None,
    }
    assert condition_view_for(None, rows)["code"] is None


# ─── list filters, summary ───────────────────────────────────────────────────
def test_condition_filters_and_split() -> None:
    assert CONDITION_FILTERS == (
        "like_new",
        "lightly_worn",
        "heavily_worn",
        "not_wearable",
    )
    assert codes_for_conditions(["heavily_worn"]) == ["C3", "C4"]
    assert codes_for_conditions(["x", "like_new"]) == ["C1"]
    assert split_multi("none, resold,,none") == ["none", "resold"]
    assert split_multi(["a,b", "c"]) == ["a", "b", "c"]
    assert split_multi(None) is None and split_multi(5) == 5
    assert codes_for_conditions(CONDITION_FILTERS) == list(CONDITION_CODES)


def test_summary_rounding_and_null() -> None:
    assert to_summary("3", "0", None, None) == {
        "pairsScanned": 3,
        "potentialValue": None,
    }
    assert to_summary(2, 2, "60.005", "130") == {
        "pairsScanned": 2,
        "potentialValue": {"min": 60.01, "max": 130, "currency": "USD"},
    }


# ─── share tokens and page ───────────────────────────────────────────────────
@settings(max_examples=200)
@given(
    st.one_of(st.none(), st.text(max_size=60)),
    st.one_of(st.none(), st.text(max_size=30)),
    st.integers(min_value=1, max_value=20),
)
def test_make_token_valid(model: str | None, brand: str | None, n: int) -> None:
    tok = make_token(model, brand, random_part(n))
    assert (
        is_valid_token(tok)
        and len(tok) <= 64
        and tok.endswith("-" + tok.split("-")[-1])
    )


def test_share_url_and_text() -> None:
    assert share_url("http://h/api/v1/", "t") == "http://h/api/v1/s/t"
    assert (
        value_text({"min": 25, "max": 40}) == "$25–$40"
        and value_text({"min": None, "max": 12.5}) == "$12.50"
    )
    view = {
        "brand": "Nike",
        "model": "Air <Max>",
        "shoeType": None,
        "color": None,
        "condition": {"grade": None, "label": None},
        "value": {"min": 25, "max": 40, "currency": "USD"},
        "recommendedAction": "repair",
        "photoUrl": None,
        "sharedAt": "x",
    }
    assert share_description(view) == "Est. resale value $25–$40"
    html = render_share_html(view, "http://h/api/v1/s/t")
    assert (
        "<title>Nike Air &lt;Max&gt;</title>" in html
        and 'class="action">Repair this pair' in html
    )
    assert 'aria-label="No photo"' in html and html.endswith("</html>\n")
