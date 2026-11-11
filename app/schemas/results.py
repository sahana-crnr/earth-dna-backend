"""F2/F3 request shapes: E10 submit, E11 query, E12 confirm, E13 reject
(src/scan/dto/submit-shoe-result.dto.ts, results-query.dto.ts, shoe-details.dto.ts)."""

from __future__ import annotations

from app.core.constants import CONDITION_CODES, GENDERS, IDENTIFICATION_OUTCOMES
from app.core.validation import (
    FieldSpec,
    Schema,
    array_max_size,
    is_array,
    is_in,
    is_not_empty,
    is_number,
    is_object,
    is_string,
    is_uuid,
    matches,
    max_length,
    max_value,
    min_value,
)

RESULT_INCLUDES: tuple[str, ...] = ("raw",)

CANDIDATE = [
    FieldSpec("brand", [is_string(), max_length(120)]),
    FieldSpec("model", [is_string(), max_length(160)], optional=True),
    FieldSpec("confidence", [is_number(), min_value(0), max_value(1)], kind="number"),
]

SUBMIT_RESULT = Schema(
    [
        FieldSpec(
            "modelVersion",
            [
                is_string(),
                max_length(64),
                matches(
                    r"^[A-Za-z0-9._@/-]+$",
                    "modelVersion may contain letters, digits and . _ @ / -",
                ),
            ],
        ),
        FieldSpec("outcome", [is_in(IDENTIFICATION_OUTCOMES)], optional=True),
        FieldSpec("brand", [is_string(), max_length(120)], optional=True),
        FieldSpec("subBrand", [is_string(), max_length(120)], optional=True),
        FieldSpec("model", [is_string(), max_length(160)], optional=True),
        FieldSpec("colorway", [is_string(), max_length(120)], optional=True),
        FieldSpec(
            "confidence",
            [is_number(), min_value(0), max_value(1)],
            optional=True,
            kind="number",
        ),
        FieldSpec("conditionCode", [is_in(CONDITION_CODES)], optional=True),
        FieldSpec(
            "candidates",
            [is_array(), array_max_size(10)],
            optional=True,
            nested=CANDIDATE,
            kind="any",
        ),
        FieldSpec("raw", [is_object()], optional=True, kind="any"),
        FieldSpec("category", [is_string(), max_length(100)], optional=True),
        FieldSpec("subCategory", [is_string(), max_length(100)], optional=True),
        FieldSpec("material", [is_string(), max_length(200)], optional=True),
    ]
)

RESULTS_QUERY = Schema([FieldSpec("include", [is_in(RESULT_INCLUDES)], optional=True)])

# E12 confirm: everything optional
SHOE_DETAILS = Schema(
    [
        FieldSpec("brandId", [is_uuid(4)], optional=True),
        FieldSpec("model", [is_string(), max_length(150)], optional=True),
        FieldSpec("color", [is_string(), max_length(100)], optional=True),
        FieldSpec("sizeId", [is_uuid(4)], optional=True),
        FieldSpec("gender", [is_in(GENDERS)], optional=True),
    ]
)

# E13 reject: brand, model, color, size required
REJECT_SHOE = Schema(
    [
        FieldSpec("brandId", [is_uuid(4)]),
        FieldSpec("model", [is_string(), is_not_empty(), max_length(150)]),
        FieldSpec("color", [is_string(), is_not_empty(), max_length(100)]),
        FieldSpec("sizeId", [is_uuid(4)]),
        FieldSpec("gender", [is_in(GENDERS)], optional=True),
    ]
)
