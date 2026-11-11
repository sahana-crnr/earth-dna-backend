"""Multipart handling with multer's observable limits (src/scan/scan-http-error.filter.ts).

Nest ran multer before anything else; its limit errors became these ApiErrors:
  file over `fileSize`        → 413 FILE_TOO_LARGE
  more than `files`           → 413 BATCH_TOO_LARGE  "Too many photos in one upload"
  more than `fields`          → 413 BATCH_TOO_LARGE  "Too many fields in one upload"
  more than `parts`           → 413 BATCH_TOO_LARGE  "Too many parts in one upload"
  text field over `fieldSize` → 413 MANIFEST_TOO_LARGE
  file part not named `file`  → 400 UNEXPECTED_FILE_FIELD (single-file routes)
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Request
from starlette.datastructures import UploadFile

from app.core.errors import ApiError
from app.services.scan import UploadedPart

FIELD_SIZE = 16 * 1024
MAX_FIELDS = 5


@dataclass
class Multipart:
    fields: dict[str, str] = field(default_factory=dict)
    files: list[UploadedPart] = field(default_factory=list)


async def read_multipart(
    request: Request,
    *,
    file_size: int,
    max_files: int,
    only_file_field: str | None = None,
) -> Multipart:
    ctype = request.headers.get("content-type", "").lower()
    if not (
        ctype.startswith("multipart/form-data")
        or ctype.startswith("application/x-www-form-urlencoded")
    ):
        return Multipart()
    form = await request.form(max_files=max_files + 50, max_fields=MAX_FIELDS + 50)
    out = Multipart()
    max_parts = max_files + MAX_FIELDS
    for parts, (name, value) in enumerate(form.multi_items(), start=1):
        if parts > max_parts:
            raise ApiError(413, "BATCH_TOO_LARGE", "Too many parts in one upload")
        if isinstance(value, UploadFile):
            if only_file_field is not None and name != only_file_field:
                raise ApiError(
                    400,
                    "UNEXPECTED_FILE_FIELD",
                    "Send the photo in a part named 'file'",
                )
            if len(out.files) >= max_files:
                raise ApiError(413, "BATCH_TOO_LARGE", "Too many photos in one upload")
            if value.size is not None and value.size > file_size:
                raise ApiError(
                    413, "FILE_TOO_LARGE", "Photo is larger than the allowed size"
                )
            data = await value.read()
            if len(data) > file_size:
                raise ApiError(
                    413, "FILE_TOO_LARGE", "Photo is larger than the allowed size"
                )
            out.files.append(UploadedPart(fieldname=name, data=data))
        else:
            if len(out.fields) >= MAX_FIELDS:
                raise ApiError(413, "BATCH_TOO_LARGE", "Too many fields in one upload")
            text = str(value)
            if len(text.encode("utf-8")) > FIELD_SIZE:
                raise ApiError(413, "MANIFEST_TOO_LARGE", "A text field is too long")
            out.fields[name] = text
    return out
