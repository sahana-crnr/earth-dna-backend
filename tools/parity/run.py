"""Send the same requests to the Node and Python services and diff the answers.

    uv run python -m tools.parity.run --node http://localhost:1234 --py http://localhost:1235
    uv run python -m tools.parity.run --unit U1        # include cases gated to U1 and earlier
    uv run python -m tools.parity.run --single --base https://dev-host   # deploy smoke

`--single` sends only the cases marked `smoke: true` (and `smoke_only: true`)
to one service and checks each `expect_status`; it is the post-deploy smoke
step and has no second service to diff against.

Exit code 0 when every case matches, 1 otherwise. Random-by-nature values
(timestamps, ids, tokens, signed URLs) are ignored by JSON path; both bodies
are still required to have the same *keys* there.
"""

from __future__ import annotations

import argparse
import json
import re
import secrets
import sys
from pathlib import Path
from typing import Any

import httpx
import yaml

SUITE = Path(__file__).with_name("suite.yaml")
UNIT_ORDER = ["U0", "U1", "U2", "U3", "U4", "U5", "U6"]


_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", re.I
)


def _mask(obj: Any, ignore: set[str], path: str = "") -> Any:
    """Replace ignored keys with a marker and UUIDs inside strings with <uuid>.

    Ignore entries may name a key (`url`), a dotted path (`data.user.id`), an
    indexed path (`data.shoes.0.id`) or a wildcard list path (`data.shoes[].id`).
    """
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            p = f"{path}.{k}" if path else k
            wild = re.sub(r"\.\d+(?=\.|$)", "[]", p)
            if k in ignore or p in ignore or wild in ignore:
                out[k] = "<ignored>"
            else:
                out[k] = _mask(v, ignore, p)
        return out
    if isinstance(obj, list):
        return [_mask(v, ignore, f"{path}.{i}") for i, v in enumerate(obj)]
    if isinstance(obj, str):
        return _UUID.sub("<uuid>", obj)
    return obj


_VAR = re.compile(r"\$\{([a-zA-Z0-9_]+)\}")


def _subst(value: Any, ctx: dict[str, str]) -> Any:
    """Replace `${name}` in strings (recursively in dicts/lists)."""
    if isinstance(value, str):
        return _VAR.sub(lambda m: ctx.get(m.group(1), m.group(0)), value)
    if isinstance(value, dict):
        return {k: _subst(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [_subst(v, ctx) for v in value]
    return value


def _pluck(obj: Any, path: str) -> Any:
    """`data.items.0.id` — dict keys and list indices."""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None
    return cur


# Generated, not stored: 1 MiB + 14 bytes, just over SCAN_PHOTO_MAX_BYTES, with
# a JPEG header so the type check passes and only the size limit trips (413).
_GENERATED = {"big.jpg": lambda: b"\xff\xd8\xff\xe0" + b"\0" * (1048590 - 4)}


def _fixture(name: str) -> bytes:
    path = Path(__file__).parent / "fixtures" / name
    if path.exists():
        return path.read_bytes()
    if name in _GENERATED:
        return _GENERATED[name]()
    raise FileNotFoundError(path)


def _send(
    client: httpx.Client, base: str, case: dict[str, Any], ctx: dict[str, str]
) -> tuple[int, Any, str]:
    files = None
    data = None
    mp = case.get("multipart")
    if mp:
        # multipart: {fields: {name: text}, files: [[part, fixture-file], ...]}
        data = _subst(mp.get("fields") or {}, ctx)
        files = [
            (part, (Path(path).name, _fixture(path)))
            for part, path in (mp.get("files") or [])
        ]
    path = _subst(case["path"], ctx)
    headers = _subst(case.get("headers"), ctx)
    unresolved = _VAR.findall(path) + _VAR.findall(json.dumps(headers or {}))
    if unresolved:
        # an earlier `save` did not produce the value: fail here, not three
        # cases later with a misleading status
        raise RuntimeError(
            f"{case['name']}: unresolved ${{{unresolved[0]}}} (earlier case failed?)"
        )
    r = client.request(
        case["method"],
        base + path,
        headers=headers,
        json=_subst(case.get("json"), ctx),
        content=case.get("body"),
        data=data,
        files=files,
    )
    try:
        body: Any = r.json()
    except ValueError:
        body = r.text
    # `save: {var: json.path}` keeps values for later cases, per target
    for var, path in (case.get("save") or {}).items():
        val = _pluck(body, path)
        if val is not None:
            ctx[var] = str(val)
    return r.status_code, body, r.headers.get("content-type", "")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default="http://localhost:1234")
    ap.add_argument("--py", default="http://localhost:1235")
    ap.add_argument("--unit", default="U0", help="run cases gated up to this unit")
    ap.add_argument("--only", default=None, help="case name filter (substring)")
    ap.add_argument(
        "--single",
        action="store_true",
        help="smoke mode: send the `smoke` cases to --base only and check expect_status",
    )
    ap.add_argument("--base", default=None, help="service URL for --single")
    args = ap.parse_args(argv)
    if args.single:
        if not args.base:
            ap.error("--single needs --base <service url>")
        return smoke(args.base, args.only)

    suite = yaml.safe_load(SUITE.read_text())
    ignore_global = set(suite.get("ignore", []))
    max_unit = UNIT_ORDER.index(args.unit)
    failures = 0
    ran = 0
    run_id = secrets.token_hex(4)
    # `${target}` differs per service so both can create "the same" user in a
    # shared local database without colliding.
    node_ctx: dict[str, str] = {"run": run_id, "target": "node"}
    py_ctx: dict[str, str] = {"run": run_id, "target": "py"}
    with httpx.Client(timeout=15.0) as client:
        for case in suite["cases"]:
            gate = case.get("skip_until_unit")
            if gate and UNIT_ORDER.index(gate) > max_unit:
                print(f"SKIP  {case['name']} (until {gate})")
                continue
            if args.only and args.only not in case["name"]:
                continue
            if case.get("smoke_only"):
                continue
            ran += 1
            ignore = ignore_global | set(case.get("ignore", []))
            ns, nb, nct = _send(client, args.node, case, node_ctx)
            ps, pb, pct = _send(client, args.py, case, py_ctx)
            n_m, p_m = _mask(nb, ignore), _mask(pb, ignore)
            if case.get("ignore_body"):
                n_m = p_m = "<ignored>"
            ok = ns == ps and n_m == p_m and nct.split(";")[0] == pct.split(";")[0]
            if "expect_status" in case and ns != case["expect_status"]:
                ok = False
            status = "OK  " if ok else "DIFF"
            print(f"{status}  {case['name']}: node={ns} py={ps}")
            if not ok:
                failures += 1
                print("   node:", json.dumps(n_m, sort_keys=True)[:600])
                print("   py  :", json.dumps(p_m, sort_keys=True)[:600])
    print(f"\n{ran - failures}/{ran} cases identical")
    return 1 if failures else 0


def smoke(base: str, only: str | None) -> int:
    """One service, status-only: proves routing, DB, S3 and JWT after a deploy."""
    suite = yaml.safe_load(SUITE.read_text())
    ctx: dict[str, str] = {"run": secrets.token_hex(4), "target": "smoke"}
    failures = 0
    ran = 0
    with httpx.Client(timeout=30.0) as client:
        for case in suite["cases"]:
            if not (case.get("smoke") or case.get("smoke_only")):
                continue
            if only and only not in case["name"]:
                continue
            ran += 1
            status, body, ctype = _send(client, base, case, ctx)
            want = case.get("expect_status")
            ok = want is None or status == want
            if ok and "json" in ctype and not isinstance(body, dict | list):
                ok = False
            print(f"{'OK  ' if ok else 'FAIL'}  {case['name']}: {status} (want {want})")
            if not ok:
                failures += 1
                print("   body:", json.dumps(body, sort_keys=True)[:600])
    print(f"\n{ran - failures}/{ran} smoke cases passed against {base}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
