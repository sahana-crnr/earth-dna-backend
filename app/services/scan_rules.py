"""Pure F1 scan rules (src/scan/scan-rules.ts): shoe completeness, labels,
renumbering, image sniffing, S3 keys and album-batch decisions."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from app.core.constants import SHOE_VIEWS, is_shoe_view

PhotoType = Literal["jpeg", "png"]

CONTENT_TYPE: dict[str, str] = {"jpeg": "image/jpeg", "png": "image/png"}
FILE_EXT: dict[str, str] = {"jpeg": "jpg", "png": "png"}


@dataclass(frozen=True)
class ShoeState:
    complete: bool
    missing: list[str]


def compute_shoe_state(views: Iterable[str]) -> ShoeState:
    have = set(views)
    missing = [v for v in SHOE_VIEWS if v not in have]
    return ShoeState(complete=len(missing) == 0, missing=missing)


def label_for(position: int) -> str:
    if not isinstance(position, int) or isinstance(position, bool) or position < 1:
        raise ValueError(f"position must be a positive integer, got {position}")
    return f"Shoe {position:02d}"


def position_from_label(label: str) -> int | None:
    m = re.match(r"^Shoe (\d{2,})$", label)
    if not m:
        return None
    n = int(m.group(1))
    return n if n >= 1 and label_for(n) == label else None


def renumber(ids_in_order: Sequence[Any]) -> dict[Any, int]:
    return {sid: i + 1 for i, sid in enumerate(ids_in_order)}


def order_by_position(shoes: Iterable[Any]) -> list[Any]:
    return sorted(shoes, key=lambda s: s.position)


@dataclass(frozen=True)
class ShoeViews:
    id: str
    position: int
    views: tuple[str, ...]


def incomplete_shoes(shoes: Iterable[ShoeViews]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in sorted(shoes, key=lambda x: x.position):
        state = compute_shoe_state(s.views)
        if not state.complete:
            out.append(
                {
                    "shoeId": s.id,
                    "label": label_for(s.position),
                    "missing": state.missing,
                }
            )
    return out


def can_finish(shoes: Sequence[ShoeViews]) -> bool:
    return len(shoes) > 0 and len(incomplete_shoes(shoes)) == 0


JPEG_MAGIC = bytes([0xFF, 0xD8, 0xFF])
PNG_MAGIC = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def sniff_image_type(data: bytes) -> str | None:
    if data[: len(JPEG_MAGIC)] == JPEG_MAGIC:
        return "jpeg"
    if data[: len(PNG_MAGIC)] == PNG_MAGIC:
        return "png"
    return None


def scan_photo_key(
    scan_id: str, shoe_id: str, view: str, photo_type: str, uid: str
) -> str:
    return f"scans/{scan_id}/{shoe_id}/{view}-{uid}.{FILE_EXT[photo_type]}"


# ─── photo checks and album decisions ────────────────────────────────────────
@dataclass(frozen=True)
class FileInfo:
    size: int
    type: str | None


@dataclass(frozen=True)
class Limits:
    photo_max_bytes: int
    allowed_types: tuple[str, ...]


def check_photo(file: FileInfo | None, limits: Limits) -> str | None:
    """'FILE_REQUIRED' | 'FILE_TOO_LARGE' | 'UNSUPPORTED_TYPE' | None."""
    if file is None or file.size == 0:
        return "FILE_REQUIRED"
    if file.size > limits.photo_max_bytes:
        return "FILE_TOO_LARGE"
    if not file.type or file.type not in limits.allowed_types:
        return "UNSUPPORTED_TYPE"
    return None


@dataclass(frozen=True)
class ManifestFile:
    field: str
    view: str


@dataclass(frozen=True)
class ManifestShoe:
    ref: str
    files: tuple[ManifestFile, ...]


@dataclass(frozen=True)
class AcceptedFile:
    field: str
    view: str
    type: str


@dataclass(frozen=True)
class Decision:
    ref: str
    accepted: bool
    files: tuple[AcceptedFile, ...] = ()
    error: str | None = None
    detail: str | None = None


def decide_album_shoes(
    shoes: Sequence[ManifestShoe],
    files: Mapping[str, FileInfo],
    limits: Limits,
    remaining_capacity: int,
) -> list[Decision]:
    ref_count: dict[str, int] = {}
    for shoe in shoes:
        for f in shoe.files:
            ref_count[f.field] = ref_count.get(f.field, 0) + 1
    capacity = max(0, remaining_capacity)
    out: list[Decision] = []
    for shoe in shoes:

        def reject(error: str, detail: str, ref: str = shoe.ref) -> Decision:
            return Decision(ref=ref, accepted=False, error=error, detail=detail)

        if len(shoe.files) == 0:
            out.append(reject("EMPTY_SHOE", "no files"))
            continue
        seen: set[str] = set()
        accepted: list[AcceptedFile] = []
        failed: Decision | None = None
        for f in shoe.files:
            if not is_shoe_view(f.view):
                failed = reject("INVALID_VIEW", f"unknown view '{f.view}'")
                break
            if f.view in seen:
                failed = reject("DUPLICATE_VIEW", f"view '{f.view}' appears twice")
                break
            seen.add(f.view)
            if ref_count.get(f.field, 0) > 1:
                failed = reject("FILE_USED_TWICE", f"file '{f.field}' used twice")
                break
            info = files.get(f.field)
            if info is None:
                failed = reject("UNKNOWN_FILE", f"no file part '{f.field}'")
                break
            bad = check_photo(info, limits)
            if bad:
                failed = reject(bad, f"file '{f.field}'")
                break
            accepted.append(
                AcceptedFile(field=f.field, view=f.view, type=str(info.type))
            )
        if failed is not None:
            out.append(failed)
            continue
        if capacity < 1:
            out.append(reject("SHOE_LIMIT_REACHED", "session is full"))
            continue
        capacity -= 1
        out.append(Decision(ref=shoe.ref, accepted=True, files=tuple(accepted)))
    return out


def view_index(view: str) -> int:
    return SHOE_VIEWS.index(view) if view in SHOE_VIEWS else len(SHOE_VIEWS)
