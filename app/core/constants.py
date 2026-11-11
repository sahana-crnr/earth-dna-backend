"""Closed value lists shared by scans, catalog and shoes (src/scan/scan.types.ts)."""

from __future__ import annotations

from typing import Literal

SHOE_VIEWS: tuple[str, ...] = ("top", "right", "left", "sole")
ShoeView = Literal["top", "right", "left", "sole"]

SCAN_STATUSES: tuple[str, ...] = (
    "draft",
    "processing",
    "review",
    "completed",
    "abandoned",
)
SCAN_SOURCES: tuple[str, ...] = ("camera", "album")
SCAN_SHOE_STATUSES: tuple[str, ...] = (
    "capturing",
    "complete",
    "analyzing",
    "identified",
    "failed",
    "confirmed",
    "rejected",
)
UPLOAD_STATUSES: tuple[str, ...] = ("pending", "uploaded")
IDENTIFICATION_SOURCES: tuple[str, ...] = ("device", "server")
CONDITION_CODES: tuple[str, ...] = ("C1", "C2", "C3", "C4", "C5")
IDENTIFICATION_OUTCOMES: tuple[str, ...] = ("identified", "failed")
RESULT_STATUSES: tuple[str, ...] = ("waiting", "identified", "failed")
GENDERS: tuple[str, ...] = ("men", "women", "unisex", "kids")
Gender = Literal["men", "women", "unisex", "kids"]
FEEDBACK_TYPES: tuple[str, ...] = (
    "confirmed",
    "corrected",
    "condition_suggested",
    "rescanned",
)
REVIEW_STATES: tuple[str, ...] = ("confirmed", "rejected")
RECOMMENDED_ACTIONS: tuple[str, ...] = ("resell", "repair", "donate", "recycle")
ACTION_TAKEN: tuple[str, ...] = ("none", "resold", "repaired", "donated", "recycled")
RESALE_BUCKETS: tuple[str, ...] = (
    "under_20",
    "from_25_to_50",
    "from_50_to_100",
    "over_100",
)
VALUE_SOURCES: tuple[str, ...] = ("static", "valuelens")
SHOE_PHOTO_SOURCES: tuple[str, ...] = ("scan", "upload")


def is_shoe_view(v: object) -> bool:
    return isinstance(v, str) and v in SHOE_VIEWS
