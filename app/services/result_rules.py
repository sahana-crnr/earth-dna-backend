"""F2 result rules (src/scan/result-rules.ts): labels, match percent,
candidate normalisation, raw payload caps."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from app.core.constants import CONDITION_CODES
from app.core.numbers import js_round

CONDITION_LABELS: dict[str, str] = {
    "C1": "Like New",
    "C2": "Lightly Worn",
    "C3": "Heavily Worn",
    "C4": "Heavily Worn",
    "C5": "Not wearable",
}


def condition_label_for(code: str | None) -> str | None:
    if code is None:
        return None
    return CONDITION_LABELS.get(code)


def is_condition_code(v: object) -> bool:
    return isinstance(v, str) and v in CONDITION_CODES


def match_percent(confidence: float | None) -> int | None:
    if confidence is None:
        return None
    try:
        f = float(confidence)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return min(100, max(0, js_round(f * 100)))


def result_status_for(outcome: str | None) -> str:
    return outcome or "waiting"


@dataclass(frozen=True)
class Candidate:
    brand: str
    model: str | None
    confidence: float

    def as_json(self) -> dict[str, Any]:
        return {"brand": self.brand, "model": self.model, "confidence": self.confidence}


def candidate_key(brand: str, model: str | None) -> str:
    return json.dumps(
        [brand.strip().lower(), (model or "").strip().lower()], separators=(",", ":")
    )


def candidate_name(brand: str, model: str | None) -> str:
    return f"{brand} {model}" if model else brand


CONFIDENCE_DP = 4


def round_confidence(confidence: float) -> float:
    scale = 10**CONFIDENCE_DP
    return float(js_round(confidence * scale) / scale)


@dataclass(frozen=True)
class CandidateDecision:
    ok: bool
    candidates: list[Candidate]
    error: str | None = None
    detail: str | None = None


def normalize_candidates(
    raw: Sequence[Mapping[str, Any]], max_count: int
) -> CandidateDecision:
    if len(raw) > max_count:
        return CandidateDecision(
            False,
            [],
            "TOO_MANY_CANDIDATES",
            f"at most {max_count} candidates, got {len(raw)}",
        )
    for c in raw:
        conf = c.get("confidence")
        ok = (
            isinstance(conf, int | float)
            and not isinstance(conf, bool)
            and conf == conf
            and 0 <= conf <= 1
        )
        if not ok:
            return CandidateDecision(
                False,
                [],
                "CONFIDENCE_OUT_OF_RANGE",
                f"candidate '{candidate_name(str(c.get('brand')), c.get('model'))}' has confidence {_js_num(conf)}",
            )
    seen: set[str] = set()
    for c in raw:
        key = candidate_key(str(c["brand"]), c.get("model"))
        if key in seen:
            return CandidateDecision(
                False,
                [],
                "DUPLICATE_CANDIDATE",
                f"'{candidate_name(str(c['brand']), c.get('model'))}' appears twice",
            )
        seen.add(key)
    out = [
        Candidate(
            brand=str(c["brand"]),
            model=c.get("model") if c.get("model") is not None else None,
            confidence=round_confidence(float(c["confidence"])),
        )
        for c in raw
    ]
    # confidence desc, then brand, then model — code-point order like JS `<`
    out.sort(key=lambda c: (-c.confidence, c.brand, c.model or ""))
    return CandidateDecision(True, out)


def _js_num(v: Any) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def check_raw_payload(raw: Any, max_bytes: int, max_depth: int = 6) -> str | None:
    """'RAW_TOO_DEEP' | 'RAW_TOO_LARGE' | None (JSON.stringify byte length)."""
    if raw is None:
        return None
    if depth_of(raw, max_depth) > max_depth:
        return "RAW_TOO_DEEP"
    encoded = json.dumps(raw, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > max_bytes:
        return "RAW_TOO_LARGE"
    return None


def depth_of(value: Any, cap: int, depth: int = 1) -> int:
    if depth > cap or not isinstance(value, dict | list):
        return depth
    children = value if isinstance(value, list) else list(value.values())
    deepest = depth
    for child in children:
        if not isinstance(child, dict | list):
            continue
        deepest = max(deepest, depth_of(child, cap, depth + 1))
        if deepest > cap:
            return deepest
    return deepest
