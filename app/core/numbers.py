"""Number formatting that matches what the Node service put on the wire.

Postgres `numeric` reached the app as a string and went through `Number()`, so
`25.00` serialised as `25` and `0.9235` as `0.9235`. Python floats would print
`25.0`; these helpers return an int when the value is integral.
"""

from __future__ import annotations

import math
from decimal import Decimal


def js_round(x: float) -> int:
    """`Math.round`: halves round toward +infinity (Python's round is banker's)."""
    return int(math.floor(x + 0.5))


def num_out(v: Decimal | float | int | None) -> int | float | None:
    if v is None:
        return None
    f = float(v)
    if not math.isfinite(f):
        return None
    return int(f) if f.is_integer() else f


def to_numeric(v: float | int | Decimal | None) -> Decimal | None:
    """Bind a JSON number to a `numeric` column the way node-postgres did: as
    its shortest decimal text (`0.92345`), not the binary expansion
    (`0.923449999…`), so Postgres rounds `numeric(5,4)` to 0.9235, not 0.9234."""
    if v is None:
        return None
    if isinstance(v, Decimal):
        return v
    if isinstance(v, bool):
        return Decimal(int(v))
    return Decimal(repr(float(v))) if isinstance(v, float) else Decimal(v)
