"""F1 scan request shapes (src/scan/dto) and the multipart manifest parser."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

from app.core.constants import SCAN_STATUSES
from app.core.errors import ApiError
from app.core.validation import (
    FieldSpec,
    Schema,
    array_max_size,
    array_min_size,
    custom,
    is_array,
    is_in,
    is_int,
    is_string,
    matches,
    max_length,
    max_value,
    min_value,
    validate_dict,
)
from app.services.scan_rules import ManifestFile, ManifestShoe


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ─── GET /scans ──────────────────────────────────────────────────────────────
class ListScansQuery(Strict):
    status: str | None = None
    limit: int | None = None
    offset: int | None = None


LIST_SCANS_QUERY = Schema(
    [
        FieldSpec("status", [is_in(SCAN_STATUSES)], optional=True),
        FieldSpec(
            "limit",
            [is_int(), min_value(1), max_value(100)],
            optional=True,
            kind="number",
        ),
        FieldSpec(
            "offset",
            [is_int(), min_value(0), max_value(100000)],
            optional=True,
            kind="number",
        ),
    ]
)


# ─── PUT .../photos/:view text fields ────────────────────────────────────────
_ISO8601 = re.compile(
    r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])"
    r"(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?)?$"
)


def is_iso8601_strict(v: Any) -> bool:
    """validator.js `isISO8601({strict: true})`: well-formed and a real date."""
    if not isinstance(v, str) or not _ISO8601.match(v):
        return False
    try:
        datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


class UploadPhotoBody(Strict):
    takenAt: str | None = None


UPLOAD_PHOTO_BODY = Schema(
    [
        FieldSpec(
            "takenAt",
            [custom(is_iso8601_strict, "takenAt must be a valid ISO 8601 date string")],
            optional=True,
        )
    ]
)


def parse_taken_at(raw: str | None) -> datetime | None:
    if not raw:
        return None
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


# ─── POST .../photos/batch ───────────────────────────────────────────────────
class AlbumBatchBody(Strict):
    manifest: str


ALBUM_BATCH_BODY = Schema([FieldSpec("manifest", [is_string(), max_length(8192)])])

SAFE = r"^[A-Za-z0-9_-]{1,40}$"

ALBUM_FILE_REF = [
    FieldSpec("field", [is_string(), matches(SAFE)]),
    FieldSpec("view", [is_string(), max_length(10)]),
]
ALBUM_SHOE = [
    FieldSpec("ref", [is_string(), matches(SAFE)]),
    FieldSpec(
        "files",
        [is_array(), array_min_size(1), array_max_size(4)],
        nested=ALBUM_FILE_REF,
        kind="any",
    ),
]
ALBUM_MANIFEST = [
    FieldSpec(
        "shoes",
        [is_array(), array_min_size(1), array_max_size(10)],
        nested=ALBUM_SHOE,
        kind="any",
    )
]


def _top_level_fields(messages: list[str], known: list[str]) -> list[str]:
    """`errors.map(e => e.property)`: one entry per failing top-level property,
    in class-validator order (unknown properties first, then declared ones)."""
    out: list[str] = []
    for m in messages:
        um = re.match(r"^property ([^. ]+) should not exist$", m)
        if um:
            name = um.group(1)
        else:
            name = next(
                (
                    k
                    for k in known
                    if m.startswith(k + " ")
                    or m.startswith(f"each value in {k} ")
                    or m.startswith(k + ".")
                ),
                None,
            )
            if name is None:
                continue
        if name not in out:
            out.append(name)
    return out


def parse_manifest(raw: str) -> list[ManifestShoe]:
    try:
        data = json.loads(raw)
    except (ValueError, TypeError, RecursionError) as exc:
        raise ApiError(400, "INVALID_MANIFEST", "manifest is not valid JSON") from exc
    if not isinstance(data, dict):
        data = {}
    messages = validate_dict(data, ALBUM_MANIFEST)
    if messages:
        raise ApiError(
            400,
            "INVALID_MANIFEST",
            "manifest does not match the expected shape",
            {"fields": _top_level_fields(messages, ["shoes"])},
        )
    return [
        ManifestShoe(
            ref=str(s["ref"]),
            files=tuple(
                ManifestFile(field=str(f["field"]), view=str(f["view"]))
                for f in s["files"]
            ),
        )
        for s in data["shoes"]
    ]
