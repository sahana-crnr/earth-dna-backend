"""F2/F3 rule properties, ported from result-rules.pbt, review-rules.pbt,
shoedna-rules.spec and integration-rules.pbt."""

from __future__ import annotations

from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.core.constants import CONDITION_CODES
from app.services.integrations import (
    IntegrationSettings,
    apply_update,
    incomplete_reason,
)
from app.services.result_rules import (
    CONDITION_LABELS,
    check_raw_payload,
    condition_label_for,
    is_condition_code,
    match_percent,
    normalize_candidates,
    result_status_for,
    round_confidence,
)
from app.services.review_rules import (
    VALUE_PLACEHOLDERS,
    Answer,
    Predicted,
    brand_corrected,
    is_completed,
    missing_fields,
    overlay_details,
    placeholder_for,
    resale_bucket_for,
    review_state_for,
    reviewed_count,
    stable_hash,
)
from app.services.shoedna_rules import map_shoedna_response


# ─── F2-P1..P3 ───────────────────────────────────────────────────────────────
def test_condition_labels_total() -> None:
    for c in CONDITION_CODES:
        assert condition_label_for(c) and CONDITION_LABELS[c]
    assert condition_label_for(None) is None and condition_label_for("C9") is None
    assert (
        is_condition_code("C1")
        and not is_condition_code("c1")
        and not is_condition_code(1)
    )


@given(st.floats(min_value=-1, max_value=2, allow_nan=False))
def test_match_percent_rounds_and_clamps(c: float) -> None:
    pct = match_percent(c)
    assert pct is not None and 0 <= pct <= 100
    if 0 <= c <= 1:
        import math

        assert pct == math.floor(c * 100 + 0.5)


def test_match_percent_pinned() -> None:
    assert (
        match_percent(0.9234) == 92
        and match_percent(0.925) == 93
        and match_percent(None) is None
    )
    assert match_percent(float("nan")) is None


def test_result_status() -> None:
    assert result_status_for(None) == "waiting"
    assert (
        result_status_for("identified") == "identified"
        and result_status_for("failed") == "failed"
    )


# ─── F2-P4 candidates ────────────────────────────────────────────────────────
cand = st.fixed_dictionaries(
    {
        "brand": st.sampled_from(["Nike", "nike ", "Adidas", "Puma"]),
        "model": st.one_of(st.none(), st.sampled_from(["Air", " air", "Ultra"])),
        "confidence": st.floats(min_value=0, max_value=1, allow_nan=False),
    }
)


@settings(max_examples=200)
@given(st.lists(cand, max_size=5), st.integers(min_value=1, max_value=4))
def test_normalize_candidates_oracle(raw: list[dict[str, Any]], max_count: int) -> None:
    d = normalize_candidates(raw, max_count)
    keys = [
        (c["brand"].strip().lower(), (c["model"] or "").strip().lower()) for c in raw
    ]
    if len(raw) > max_count:
        assert not d.ok and d.error == "TOO_MANY_CANDIDATES"
    elif len(set(keys)) != len(keys):
        assert not d.ok and d.error == "DUPLICATE_CANDIDATE"
    else:
        assert d.ok and len(d.candidates) == len(raw)
        confs = [c.confidence for c in d.candidates]
        assert confs == sorted(confs, reverse=True)
        assert all(c.confidence == round_confidence(c.confidence) for c in d.candidates)
        assert all(0 <= c.confidence <= 1 for c in d.candidates)
        # order of the input does not matter
        again = normalize_candidates(list(reversed(raw)), max_count)
        assert again.ok and again.candidates == d.candidates


def test_candidate_rejections_pinned() -> None:
    too = normalize_candidates(
        [{"brand": f"b{i}", "confidence": 0.1} for i in range(4)], 3
    )
    assert (too.error, too.detail) == (
        "TOO_MANY_CANDIDATES",
        "at most 3 candidates, got 4",
    )
    dup = normalize_candidates(
        [
            {"brand": "Nike", "model": "Air", "confidence": 0.1},
            {"brand": " nike ", "model": "AIR", "confidence": 0.2},
        ],
        3,
    )
    assert (dup.error, dup.detail) == (
        "DUPLICATE_CANDIDATE",
        "' nike  AIR' appears twice",
    )  # Node golden
    out = normalize_candidates([{"brand": "x", "confidence": 1.5}], 3)
    assert (
        out.error == "CONFIDENCE_OUT_OF_RANGE"
        and out.detail == "candidate 'x' has confidence 1.5"
    )
    ok = normalize_candidates([{"brand": "Nike", "confidence": 0.92345}], 3)
    assert (
        ok.ok
        and ok.candidates[0].confidence == 0.9235
        and ok.candidates[0].model is None
    )


# ─── F2-P5 raw ───────────────────────────────────────────────────────────────
def test_raw_payload_caps() -> None:
    assert check_raw_payload(None, 100) is None
    assert check_raw_payload({"a": "x" * 50}, 100) is None
    assert check_raw_payload({"a": "x" * 200}, 100) == "RAW_TOO_LARGE"
    deep: Any = {"a": {"b": {"c": {"d": {"e": {"f": {"g": 1}}}}}}}
    assert check_raw_payload(deep, 10_000) == "RAW_TOO_DEEP"
    assert (
        check_raw_payload({"a": {"b": {"c": {"d": {"e": {"f": 1}}}}}}, 10_000) is None
    )
    assert check_raw_payload([[[[[[[1]]]]]]], 10_000) == "RAW_TOO_DEEP"  # arrays count
    # depth before size
    assert (
        check_raw_payload(
            {"a": {"b": {"c": {"d": {"e": {"f": {"g": "x" * 999}}}}}}}, 10
        )
        == "RAW_TOO_DEEP"
    )


# ─── F3-P1 overlay ───────────────────────────────────────────────────────────
pred = Predicted("Nike", "Air Max", "Black", "Jordan", "Running", "Road", "C2", "Mesh")


def test_overlay_pinned() -> None:
    out = overlay_details(pred, Answer())
    assert (out.brand, out.model, out.color, out.size, out.sub_brand) == (
        "Nike",
        "Air Max",
        "Black",
        None,
        "Jordan",
    )
    out = overlay_details(
        pred, Answer(brand="  Adidas ", model=" ", color="Red", size="9", gender="men")
    )
    assert (out.brand, out.model, out.color, out.size, out.gender) == (
        "Adidas",
        "Air Max",
        "Red",
        "9",
        "men",
    )
    assert out.sub_brand is None  # changed brand drops the predicted sub-brand
    assert (
        brand_corrected("Nike", "Adidas")
        and not brand_corrected("Nike", " nike ")
        and not brand_corrected("Nike", None)
    )
    unknown = overlay_details(
        Predicted("Unknown", None, None, None, None, None, None, None), Answer()
    )
    assert unknown.brand is None
    assert brand_corrected("Unknown", "Nike")
    assert (out.category, out.sub_category, out.condition_code, out.material) == (
        "Running",
        "Road",
        "C2",
        "Mesh",
    )


# ─── F3-P2/P3/P5 review bookkeeping ──────────────────────────────────────────
statuses = st.lists(
    st.sampled_from(["capturing", "identified", "failed", "confirmed", "rejected"]),
    max_size=5,
)


@given(statuses)
def test_reviewed_count_and_completed(ss: list[str]) -> None:
    c = reviewed_count(ss)
    assert c["total"] == len(ss) and c["done"] == sum(
        1 for s in ss if s in ("confirmed", "rejected")
    )
    assert is_completed(ss) is (len(ss) > 0 and c["done"] == len(ss))
    for s in ss:
        assert review_state_for(s) == (s if s in ("confirmed", "rejected") else None)


def test_missing_fields() -> None:
    assert missing_fields("confirm", Answer()) == []
    assert missing_fields("reject", Answer(brand="Nike", model="  ", size="9")) == [
        "model",
        "color",
    ]
    assert missing_fields("reject", Answer("a", "b", "c", "d")) == []


# ─── F3-P4 placeholders ──────────────────────────────────────────────────────
@given(st.text(min_size=1, max_size=40))
def test_placeholder_deterministic(s: str) -> None:
    assert (
        placeholder_for(s) is placeholder_for(s)
        and placeholder_for(s) in VALUE_PLACEHOLDERS
    )
    assert 0 <= stable_hash(s) <= 0xFFFFFFFF


def test_placeholder_spreads_and_matches_node_hash() -> None:
    ids = [f"8c2c2209-82af-4bbe-b49c-e521066e99{i:02d}" for i in range(60)]
    assert len({id(placeholder_for(i)) for i in ids}) == 4
    # Node golden: shoe 8c2c2209-82af-4bbe-b49c-e521066e9925 got the "repair" option
    assert (
        placeholder_for("8c2c2209-82af-4bbe-b49c-e521066e9925")["recommendedAction"]
        == "repair"
    )
    for p in VALUE_PLACEHOLDERS:
        if p["resaleMax"] is None:
            assert p["resaleMin"] is None and p["resaleBucket"] is None
        else:
            assert p["resaleMin"] <= p["resaleMax"]  # type: ignore[operator]
            assert resale_bucket_for(p["resaleMax"]) == p["resaleBucket"]


@given(st.one_of(st.none(), st.floats(min_value=0, max_value=500, allow_nan=False)))
def test_resale_bucket_total_monotone(v: float | None) -> None:
    b = resale_bucket_for(v)
    if v is None:
        assert b is None
    else:
        assert b == (
            "under_20"
            if v < 20
            else "from_25_to_50"
            if v <= 50
            else "from_50_to_100"
            if v <= 100
            else "over_100"
        )


# ─── ShoeDNA mapping ─────────────────────────────────────────────────────────
OPTS = {"max_candidates": 3, "raw_max_bytes": 8192, "version_fallback": "v9"}


def test_map_full_answer() -> None:
    m = map_shoedna_response(
        {
            "modelVersion": "srv-1",
            "brand": " Nike ",
            "model": "Air",
            "confidence": 0.8,
            "conditionCode": "C2",
            "candidates": [
                {"brand": "Nike", "confidence": 0.8},
                {"brand": "nike", "confidence": 0.7},
            ],
            "extra": 1,
        },
        **OPTS,
    )
    assert m.ok and m.fields is not None
    f = m.fields
    assert (
        f["source"] == "server"
        and f["outcome"] == "identified"
        and f["brand"] == "Nike"
    )
    assert f["modelVersion"] == "srv-1" and [c.brand for c in f["candidates"]] == [
        "Nike"
    ]
    assert f["raw"]["extra"] == 1 and not m.raw_dropped


def test_map_failed_and_fallbacks() -> None:
    assert map_shoedna_response({}, **OPTS).fields["outcome"] == "failed"  # type: ignore[index]
    assert map_shoedna_response({"brand": "Nike"}, **OPTS).fields["outcome"] == "failed"  # type: ignore[index]
    assert (
        map_shoedna_response(
            {"brand": "Nike", "confidence": 0.5, "outcome": "failed"}, **OPTS
        ).fields["outcome"]
        == "failed"
    )  # type: ignore[index]
    assert (
        map_shoedna_response({"modelVersion": "bad version!"}, **OPTS).fields[
            "modelVersion"
        ]
        == "v9"
    )  # type: ignore[index]
    assert (
        map_shoedna_response(
            {}, max_candidates=3, raw_max_bytes=8192, version_fallback=None
        ).fields["modelVersion"]
        == "shoedna-server"
    )  # type: ignore[index]
    big = map_shoedna_response({"blob": "x" * 9000}, **OPTS)
    assert big.ok and big.raw_dropped and big.fields["raw"] is None  # type: ignore[index]
    assert not map_shoedna_response([], **OPTS).ok
    assert not map_shoedna_response({"brand": 5}, **OPTS).ok
    assert not map_shoedna_response({"confidence": 2}, **OPTS).ok
    assert not map_shoedna_response(
        {"candidates": [{"brand": "", "confidence": 0.5}]}, **OPTS
    ).ok


# ─── integrations ────────────────────────────────────────────────────────────
cur = IntegrationSettings("https://a.test", "1", "earthdna/x", True)


def test_apply_update_semantics() -> None:
    assert apply_update(cur, {}) == cur
    assert apply_update(cur, {"baseUrl": None}).base_url is None
    assert apply_update(cur, {"version": "2", "enabled": None}) == IntegrationSettings(
        "https://a.test", "2", "earthdna/x", True
    )
    assert apply_update(cur, {"enabled": False}).enabled is False
    patch = {"baseUrl": "https://b.test", "authRef": None}
    once = apply_update(cur, patch)
    assert apply_update(once, patch) == once
    reason = incomplete_reason(IntegrationSettings(None, None, None, True))
    assert reason == "An integration cannot be enabled without a baseUrl"
    assert incomplete_reason(IntegrationSettings(None, None, None, False)) is None


@pytest.mark.parametrize(
    ("url", "ok"),
    [
        ("https://shoedna.example.com/v2", True),
        ("http://x.test", False),
        ("https://u:p@x.test", False),
        ("https://x.test/?q=1", False),
        ("https://x.test/#f", False),
        ("not a url", False),
        ("https://localhost:8443/api", True),
    ],
)
def test_https_url_rule(url: str, ok: bool) -> None:
    from app.schemas.integrations import is_https_url

    assert is_https_url(url) is ok
