"""F4 to F7 request shapes (src/shoes/dto)."""

from __future__ import annotations

from app.core.constants import (
    ACTION_TAKEN,
    CONDITION_CODES,
    GENDERS,
    RECOMMENDED_ACTIONS,
    RESALE_BUCKETS,
)
from app.core.validation import (
    FieldSpec,
    Schema,
    array_max_size,
    is_array,
    is_in,
    is_int,
    is_string,
    is_uuid,
    max_length,
    max_value,
    min_length,
    min_value,
    trim,
)
from app.services.shoe_rules import CONDITION_FILTERS, split_multi


def _multi(name: str, values: tuple[str, ...]) -> FieldSpec:
    return FieldSpec(
        name,
        [is_array(), array_max_size(len(values))],
        optional=True,
        transforms=[split_multi],
        each_rules=[is_in(values)],
        kind="any",
    )


LIST_SHOES_QUERY = Schema(
    [
        _multi("actionTaken", ACTION_TAKEN),
        _multi("condition", CONDITION_FILTERS),
        _multi("recommendedAction", RECOMMENDED_ACTIONS),
        _multi("resaleBucket", RESALE_BUCKETS),
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

# E22: `string | null` properties are not implicitly converted (union type),
# ValidateIf(v !== null) lets null through to mean "clear".
UPDATE_SHOE = Schema(
    [
        FieldSpec("brandId", [is_uuid(4)], optional=True, skip_null=False, kind="any"),
        FieldSpec(
            "model",
            [is_string(), max_length(150)],
            optional=True,
            transforms=[trim],
            kind="any",
        ),
        FieldSpec(
            "color",
            [is_string(), max_length(100)],
            optional=True,
            transforms=[trim],
            kind="any",
        ),
        FieldSpec("sizeId", [is_uuid(4)], optional=True, kind="any"),
        FieldSpec("shoeTypeId", [is_uuid(4)], optional=True, kind="any"),
        FieldSpec("gender", [is_in(GENDERS)], optional=True, kind="any"),
        FieldSpec("actionTaken", [is_in(ACTION_TAKEN)], optional=True, kind="any"),
        FieldSpec(
            "primaryPhotoId", [is_uuid(4)], optional=True, skip_null=False, kind="any"
        ),
    ]
)

CONDITION_FEEDBACK = Schema(
    [
        FieldSpec("suggestedConditionCode", [is_in(CONDITION_CODES)]),
        FieldSpec(
            "reason", [is_string(), min_length(1), max_length(500)], transforms=[trim]
        ),
    ]
)
