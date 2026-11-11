"""The stamp-or-upgrade decision in tools/migrate.py is pure; pin every branch."""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st
from tools.migrate import decide

from app.models import NODE_MIGRATIONS


def test_branches() -> None:
    assert decide("0001", []) == "upgrade"
    assert decide(None, []) == "fresh"
    assert decide(None, list(NODE_MIGRATIONS)) == "stamp"
    assert decide(None, list(NODE_MIGRATIONS)[:-1]) == "refuse"
    assert decide(None, ["Something9999"]) == "refuse"
    # tables exist but neither ledger: never create_all over them
    assert decide(None, [], app_tables=True) == "refuse"
    assert decide("0001", [], app_tables=True) == "upgrade"
    assert decide(None, list(NODE_MIGRATIONS), app_tables=True) == "stamp"


@given(
    st.lists(st.sampled_from([*list(NODE_MIGRATIONS), "Extra1", "Extra2"]), unique=True)
)
def test_stamp_iff_all_node_rows_present(applied: list[str]) -> None:
    out = decide(None, applied)
    if set(NODE_MIGRATIONS).issubset(applied):
        assert out == "stamp"
    elif applied:
        assert out == "refuse"
    else:
        assert out == "fresh"
