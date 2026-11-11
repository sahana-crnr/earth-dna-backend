"""F1 scan rule properties P1 to P6, ported from src/scan/scan-rules.pbt.spec.ts."""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.core.constants import SHOE_VIEWS
from app.schemas.scan import is_iso8601_strict, parse_manifest
from app.services.scan_rules import (
    FileInfo,
    Limits,
    ManifestFile,
    ManifestShoe,
    ShoeViews,
    can_finish,
    check_photo,
    compute_shoe_state,
    decide_album_shoes,
    incomplete_shoes,
    label_for,
    position_from_label,
    renumber,
    scan_photo_key,
    sniff_image_type,
)

views = st.lists(st.sampled_from(SHOE_VIEWS), max_size=8)


@settings(max_examples=200)
@given(views)
def test_p1_complete_iff_all_four_distinct(vs: list[str]) -> None:
    state = compute_shoe_state(vs)
    distinct = set(vs)
    assert state.complete is (len(distinct) == 4)
    assert state.missing == [v for v in SHOE_VIEWS if v not in distinct]
    # order and duplicates do not matter
    assert compute_shoe_state(list(reversed(vs)) + vs) == state


@given(st.integers(min_value=1, max_value=10_000))
def test_p2_labels_round_trip(n: int) -> None:
    label = label_for(n)
    assert position_from_label(label) == n
    assert label == f"Shoe {n:02d}"


@pytest.mark.parametrize(
    "bad", ["Shoe 1", "Shoe 001", "shoe 01", "Shoe 00", "Shoe", ""]
)
def test_p2_rejects_non_labels(bad: str) -> None:
    assert position_from_label(bad) is None


def test_label_for_rejects_bad_positions() -> None:
    for bad in (0, -1, 1.5, True):
        with pytest.raises(ValueError, match="positive integer"):
            label_for(bad)  # type: ignore[arg-type]


@given(st.lists(st.uuids(), unique=True, max_size=10))
def test_p3_renumber_contiguous(ids: list[object]) -> None:
    out = renumber(ids)
    assert list(out.values()) == list(range(1, len(ids) + 1))
    assert list(out) == ids


shoes_arb = st.lists(
    st.builds(
        lambda i, vs: ShoeViews(id=f"s{i}", position=i + 1, views=tuple(vs)),
        st.integers(min_value=0, max_value=3),
        views,
    ),
    max_size=4,
)


@settings(max_examples=200)
@given(shoes_arb)
def test_p4_can_finish_oracle(shoes: list[ShoeViews]) -> None:
    expected = len(shoes) > 0 and all(len(set(s.views)) == 4 for s in shoes)
    assert can_finish(shoes) is expected
    inc = incomplete_shoes(shoes)
    assert [i["shoeId"] for i in inc] == [
        s.id for s in sorted(shoes, key=lambda s: s.position) if len(set(s.views)) < 4
    ]
    assert all(
        i["label"] == label_for(next(s.position for s in shoes if s.id == i["shoeId"]))
        for i in inc
    )


def test_p4_empty_shoe_blocks_finish() -> None:
    full = ShoeViews("a", 1, tuple(SHOE_VIEWS))
    empty = ShoeViews("b", 2, ())
    assert can_finish([full]) and not can_finish([full, empty]) and not can_finish([])


@given(st.binary(max_size=16))
def test_p6_sniff_only_magic(data: bytes) -> None:
    out = sniff_image_type(data)
    if data.startswith(b"\xff\xd8\xff"):
        assert out == "jpeg"
    elif data.startswith(b"\x89PNG\r\n\x1a\n"):
        assert out == "png"
    else:
        assert out is None


def test_p6_rejects_gif_and_empty() -> None:
    assert sniff_image_type(b"GIF89a....") is None and sniff_image_type(b"") is None


LIMITS = Limits(photo_max_bytes=1000, allowed_types=("jpeg", "png"))


@given(
    st.integers(min_value=0, max_value=2000),
    st.sampled_from(["jpeg", "png", "gif", None]),
)
def test_check_photo_oracle(size: int, kind: str | None) -> None:
    out = check_photo(FileInfo(size=size, type=kind), LIMITS)
    if size == 0:
        assert out == "FILE_REQUIRED"
    elif size > 1000:
        assert out == "FILE_TOO_LARGE"
    elif kind not in ("jpeg", "png"):
        assert out == "UNSUPPORTED_TYPE"
    else:
        assert out is None
    assert check_photo(None, LIMITS) == "FILE_REQUIRED"


def test_scan_photo_key_layout() -> None:
    assert scan_photo_key("S", "H", "top", "jpeg", "U") == "scans/S/H/top-U.jpg"
    assert scan_photo_key("S", "H", "sole", "png", "U") == "scans/S/H/sole-U.png"


# ─── P5 decideAlbumShoes ─────────────────────────────────────────────────────
file_refs = st.lists(
    st.builds(
        ManifestFile,
        field=st.sampled_from(["f1", "f2", "f3", "f4", "f5"]),
        view=st.sampled_from([*SHOE_VIEWS, "front"]),
    ),
    max_size=5,
)
manifest_arb = st.lists(
    st.builds(
        ManifestShoe,
        ref=st.sampled_from(["a", "b", "c", "d"]),
        files=file_refs.map(tuple),
    ),
    max_size=4,
)
files_arb = st.dictionaries(
    st.sampled_from(["f1", "f2", "f3", "f4"]),
    st.builds(
        FileInfo,
        size=st.integers(min_value=0, max_value=1500),
        type=st.sampled_from(["jpeg", "png", None]),
    ),
    max_size=4,
)


@settings(max_examples=300)
@given(manifest_arb, files_arb, st.integers(min_value=0, max_value=4))
def test_p5_decisions_match_oracle(
    shoes: list[ManifestShoe], files: dict[str, FileInfo], capacity: int
) -> None:
    out = decide_album_shoes(shoes, files, LIMITS, capacity)
    assert [d.ref for d in out] == [s.ref for s in shoes]
    assert sum(1 for d in out if d.accepted) <= capacity
    field_count: dict[str, int] = {}
    for s in shoes:
        for f in s.files:
            field_count[f.field] = field_count.get(f.field, 0) + 1
    cap = max(0, capacity)
    for s, d in zip(shoes, out, strict=True):
        valid = (
            len(s.files) > 0
            and all(f.view in SHOE_VIEWS for f in s.files)
            and len({f.view for f in s.files}) == len(s.files)
            and all(field_count[f.field] == 1 for f in s.files)
            and all(
                f.field in files and check_photo(files[f.field], LIMITS) is None
                for f in s.files
            )
        )
        if valid and cap > 0:
            assert d.accepted
            cap -= 1
            assert [(f.field, f.view, f.type) for f in d.files] == [
                (f.field, f.view, files[f.field].type) for f in s.files
            ]
        else:
            assert not d.accepted and d.error and d.detail
            if valid:
                assert d.error == "SHOE_LIMIT_REACHED"


def test_p5_pinned_errors() -> None:
    files = {
        "f1": FileInfo(10, "jpeg"),
        "f2": FileInfo(10, "png"),
        "f3": FileInfo(10, "png"),
    }
    shoes = [
        ManifestShoe("a", ()),
        ManifestShoe("b", (ManifestFile("f1", "front"),)),
        ManifestShoe("c", (ManifestFile("f3", "top"), ManifestFile("f2", "top"))),
        ManifestShoe("d", (ManifestFile("f9", "top"),)),
    ]
    out = decide_album_shoes(shoes, files, LIMITS, 4)
    assert [(d.error, d.detail) for d in out] == [
        ("EMPTY_SHOE", "no files"),
        ("INVALID_VIEW", "unknown view 'front'"),
        ("DUPLICATE_VIEW", "view 'top' appears twice"),
        ("UNKNOWN_FILE", "no file part 'f9'"),
    ]
    twice = decide_album_shoes(
        [
            ManifestShoe("a", (ManifestFile("f1", "top"),)),
            ManifestShoe("b", (ManifestFile("f1", "left"),)),
        ],
        files,
        LIMITS,
        4,
    )
    assert [d.error for d in twice] == ["FILE_USED_TWICE", "FILE_USED_TWICE"]


# ─── manifest parser and ISO 8601 ────────────────────────────────────────────
def test_parse_manifest_errors_and_shape() -> None:
    from app.core.errors import ApiError

    with pytest.raises(ApiError) as bad:
        parse_manifest("{bad")
    assert (
        bad.value.code == "INVALID_MANIFEST"
        and bad.value.message == "manifest is not valid JSON"
    )
    with pytest.raises(ApiError) as shape:
        parse_manifest('{"shoes":[{"ref":"a","files":[]}],"x":1}')
    assert shape.value.details == {"fields": ["x", "shoes"]}  # Node golden
    ok = parse_manifest('{"shoes":[{"ref":"a","files":[{"field":"f1","view":"top"}]}]}')
    assert ok == [ManifestShoe("a", (ManifestFile("f1", "top"),))]


@pytest.mark.parametrize(
    ("raw", "ok"),
    [
        ("2026-09-29T10:15:00.000Z", True),
        ("2026-09-29", True),
        ("2026-13-01", False),
        ("yesterday", False),
        ("2026-02-30", False),
        ("2026-09-29T25:00:00Z", False),
        ("2026-09-29T10:15:00+05:30", True),
    ],
)
def test_iso8601_strict(raw: str, ok: bool) -> None:
    assert is_iso8601_strict(raw) is ok
