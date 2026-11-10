"""Mapping of a ShoeDNA server answer onto a stored result (src/scan/shoedna-rules.ts)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.services.result_rules import (
    Candidate,
    candidate_key,
    check_raw_payload,
    is_condition_code,
    normalize_candidates,
)

MODEL_VERSION = re.compile(r"^[A-Za-z0-9._@/-]{1,64}$")
FALLBACK_MODEL_VERSION = "shoedna-server"
LIMITS: dict[str, int] = {
    "brand": 120,
    "subBrand": 120,
    "model": 160,
    "colorway": 120,
    "category": 100,
    "subCategory": 100,
    "material": 200,
}

_INVALID = object()


@dataclass
class Mapping:
    ok: bool
    fields: dict[str, Any] | None = None
    raw_dropped: bool = False
    reason: str | None = None


def map_shoedna_response(
    body: Any, *, max_candidates: int, raw_max_bytes: int, version_fallback: str | None
) -> Mapping:
    if not isinstance(body, dict):
        return Mapping(False, reason="response is not a JSON object")
    text: dict[str, str | None] = {}
    for key, limit in LIMITS.items():
        v = optional_text(body.get(key), limit)
        if v is _INVALID:
            return Mapping(False, reason=f"{key} is not a string of ≤{limit} chars")
        text[key] = v
    confidence = body.get("confidence")
    if confidence is not None and not is_unit(confidence):
        return Mapping(False, reason="confidence is not a number in 0..1")
    condition_code = body.get("conditionCode")
    if condition_code is not None and not is_condition_code(condition_code):
        return Mapping(False, reason="conditionCode is not one of C1..C5")
    candidates = map_candidates(body.get("candidates"), max_candidates)
    if isinstance(candidates, str):
        return Mapping(False, reason=candidates)
    outcome = (
        "identified"
        if body.get("outcome") != "failed" and text["brand"] and confidence is not None
        else "failed"
    )
    raw_ok = check_raw_payload(body, raw_max_bytes) is None
    return Mapping(
        True,
        raw_dropped=not raw_ok,
        fields={
            "source": "server",
            "outcome": outcome,
            "modelVersion": pick_model_version(
                body.get("modelVersion"), version_fallback
            ),
            **text,
            "confidence": confidence,
            "conditionCode": condition_code,
            "candidates": candidates,
            "raw": body if raw_ok else None,
        },
    )


def map_candidates(value: Any, max_count: int) -> list[Candidate] | str:
    if value is None:
        return []
    if not isinstance(value, list):
        return "candidates is not an array"
    parsed: list[dict[str, Any]] = []
    for c in value:
        if not isinstance(c, dict):
            return "a candidate is not an object"
        brand = optional_text(c.get("brand"), LIMITS["brand"])
        model = optional_text(c.get("model"), LIMITS["model"])
        if brand is _INVALID or not brand:
            return "a candidate has no valid brand"
        if model is _INVALID:
            return "a candidate has an invalid model"
        if not is_unit(c.get("confidence")):
            return "a candidate confidence is not in 0..1"
        parsed.append({"brand": brand, "model": model, "confidence": c["confidence"]})
    seen: set[str] = set()
    top: list[dict[str, Any]] = []
    for c in sorted(parsed, key=lambda x: -float(x["confidence"])):
        key = candidate_key(str(c["brand"]), c["model"])
        if key in seen:
            continue
        seen.add(key)
        top.append(c)
    decision = normalize_candidates(top[:max_count], max_count)
    return (
        decision.candidates
        if decision.ok
        else (decision.detail or "invalid candidates")
    )


def pick_model_version(value: Any, fallback: str | None) -> str:
    if isinstance(value, str) and MODEL_VERSION.match(value):
        return value
    if fallback and MODEL_VERSION.match(fallback):
        return fallback
    return FALLBACK_MODEL_VERSION


def optional_text(value: Any, max_len: int) -> Any:
    """None → None; non-string or too long → _INVALID; blank → None."""
    if value is None:
        return None
    if not isinstance(value, str):
        return _INVALID
    v = value.strip()
    if len(v) > max_len:
        return _INVALID
    return v or None


def is_unit(v: Any) -> bool:
    return (
        isinstance(v, int | float)
        and not isinstance(v, bool)
        and v == v
        and v not in (float("inf"), float("-inf"))
        and 0 <= v <= 1
    )
