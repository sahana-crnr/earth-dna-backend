"""F1 scan flows against the database (PY_IT_DB=1) with an in-memory object
store, ported from scan.service.it.spec.ts."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete

from app.main import build_services, create_app
from app.models import User
from app.services.scan import ScanService
from app.services.storage import MemoryPhotoStorage
from tests.conftest import make_settings, requires_db

pytestmark = [requires_db, pytest.mark.db]

RUN = uuid.uuid4().hex[:6]
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
GIF = b"GIF89a" + b"\x00" * 16


@pytest.fixture
async def env() -> AsyncIterator[dict[str, Any]]:
    settings = make_settings(
        MAIL_DRY_RUN=True, SHOE_PHOTOS_BUCKET="test-bucket", SCAN_MAX_OPEN_DRAFTS=3
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        storage = MemoryPhotoStorage()
        build_services(app, settings, app.state.session_factory, storage=storage)
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://t"
        ) as c:
            tokens = []
            for who in ("a", "b"):
                reg = await c.post(
                    "/api/v1/auth/register",
                    json={
                        "fullName": who,
                        "email": f"scan-{who}-{RUN}@pyflow.test",
                        "password": "Passw0rd!xyz",
                        "country": "US",
                    },
                )
                tokens.append(
                    {"Authorization": f"Bearer {reg.json()['data']['accessToken']}"}
                )
            try:
                yield {
                    "app": app,
                    "c": c,
                    "h": tokens[0],
                    "h2": tokens[1],
                    "storage": storage,
                }
            finally:
                async with app.state.engine.begin() as conn:
                    await conn.execute(
                        delete(User).where(User.email.like(f"scan-%-{RUN}@pyflow.test"))
                    )


async def _put(
    c: AsyncClient,
    h: dict[str, str],
    sid: str,
    shoe: str,
    view: str,
    data: bytes = JPEG,
    **fields: str,
) -> Any:
    return await c.put(
        f"/api/v1/scans/{sid}/shoes/{shoe}/photos/{view}",
        headers=h,
        files={"file": ("p.jpg", data, "image/jpeg")},
        data=fields or None,
    )


async def test_session_lifecycle(env: dict[str, Any]) -> None:
    c, h, storage = env["c"], env["h"], env["storage"]
    r = await c.post("/api/v1/scans", headers=h)
    assert r.status_code == 201
    s = r.json()["data"]
    assert set(s) == {
        "id",
        "status",
        "source",
        "createdAt",
        "updatedAt",
        "finishedAt",
        "canFinish",
        "shoes",
    }
    assert s["status"] == "draft" and s["shoes"] == [] and s["canFinish"] is False
    sid = s["id"]

    lst = await c.get(
        "/api/v1/scans", headers=h, params={"status": "draft", "limit": 1}
    )
    d = lst.json()["data"]
    assert d["limit"] == 1 and d["offset"] == 0 and d["items"][0]["id"] == sid
    assert set(d["items"][0]) == {
        "id",
        "status",
        "source",
        "createdAt",
        "updatedAt",
        "finishedAt",
        "shoeCount",
        "completeShoes",
        "canFinish",
    }
    bad = await c.get(
        "/api/v1/scans",
        headers=h,
        params={"status": "nope", "limit": "abc", "offset": "-1"},
    )
    assert bad.json()["message"] == [
        "status must be one of the following values: draft, processing, review, completed, abandoned",
        "limit must not be greater than 100",
        "limit must not be less than 1",
        "limit must be an integer number",
        "offset must not be less than 0",
    ]

    # four shoes, the fifth is refused
    for _ in range(4):
        assert (
            await c.post(f"/api/v1/scans/{sid}/shoes", headers=h)
        ).status_code == 201
    fifth = await c.post(f"/api/v1/scans/{sid}/shoes", headers=h)
    assert fifth.status_code == 409 and fifth.json()["code"] == "SHOE_LIMIT_REACHED"
    shoes = (await c.get(f"/api/v1/scans/{sid}", headers=h)).json()["data"]["shoes"]
    assert [x["label"] for x in shoes] == ["Shoe 01", "Shoe 02", "Shoe 03", "Shoe 04"]
    assert (
        shoes[0]["missing"] == ["top", "right", "left", "sole"]
        and shoes[0]["status"] == "capturing"
    )

    # another user: 404 everywhere (IDOR)
    for res in (
        await c.get(f"/api/v1/scans/{sid}", headers=env["h2"]),
        await c.post(f"/api/v1/scans/{sid}/shoes", headers=env["h2"]),
        await c.delete(f"/api/v1/scans/{sid}", headers=env["h2"]),
    ):
        assert res.status_code == 404 and res.json()["code"] == "SCAN_NOT_FOUND"

    # delete shoe 2 → renumbered, objects removed
    first, second = shoes[0]["id"], shoes[1]["id"]
    await _put(c, h, sid, second, "top")
    assert len(storage.objects) == 1
    after = await c.delete(f"/api/v1/scans/{sid}/shoes/{second}", headers=h)
    assert [x["position"] for x in after.json()["data"]["shoes"]] == [1, 2, 3]
    assert storage.objects == {}
    assert (await c.delete(f"/api/v1/scans/{sid}/shoes/{second}", headers=h)).json()[
        "code"
    ] == "SHOE_NOT_FOUND"

    # uploads: bad file rejected before storage, retake replaces the object
    bad_type = await _put(c, h, sid, first, "top", GIF)
    assert bad_type.status_code == 415 and bad_type.json()["code"] == "UNSUPPORTED_TYPE"
    nofile = await c.put(f"/api/v1/scans/{sid}/shoes/{first}/photos/top", headers=h)
    assert nofile.status_code == 400 and nofile.json()["code"] == "FILE_REQUIRED"
    badview = await _put(c, h, sid, first, "front")
    assert badview.status_code == 400 and badview.json()["code"] == "INVALID_VIEW"
    wrongfield = await c.put(
        f"/api/v1/scans/{sid}/shoes/{first}/photos/top",
        headers=h,
        files={"photo": ("p.jpg", JPEG)},
    )
    assert (
        wrongfield.status_code == 400
        and wrongfield.json()["code"] == "UNEXPECTED_FILE_FIELD"
    )
    badtaken = await _put(c, h, sid, first, "top", takenAt="yesterday")
    assert badtaken.json()["message"] == [
        "takenAt must be a valid ISO 8601 date string"
    ]
    assert storage.objects == {}

    up1 = await _put(c, h, sid, first, "top", takenAt="2026-09-29T10:15:00.000Z")
    assert up1.status_code == 200
    photo = up1.json()["data"]["shoes"][0]["photos"][0]
    assert (
        photo["view"] == "top"
        and photo["contentType"] == "image/jpeg"
        and photo["bytes"] == len(JPEG)
    )
    assert photo["takenAt"] == "2026-09-29T10:15:00.000Z" and photo["url"].startswith(
        "memory://"
    )
    key1 = next(iter(storage.objects))
    up2 = await _put(c, h, sid, first, "top", PNG)
    assert up2.json()["data"]["shoes"][0]["photos"][0]["contentType"] == "image/png"
    assert len(storage.objects) == 1 and key1 not in storage.objects

    # finish: incomplete → 409 with details; complete one shoe only → still incomplete
    inc = await c.post(f"/api/v1/scans/{sid}/finish", headers=h)
    assert inc.status_code == 409 and inc.json()["code"] == "SCAN_INCOMPLETE"
    assert inc.json()["details"]["incomplete"][0]["label"] == "Shoe 01"
    assert inc.json()["details"]["incomplete"][0]["missing"] == [
        "right",
        "left",
        "sole",
    ]

    # remove the two empty shoes, complete the first, finish
    ids = [
        x["id"]
        for x in (await c.get(f"/api/v1/scans/{sid}", headers=h)).json()["data"][
            "shoes"
        ]
    ]
    for extra in ids[1:]:
        await c.delete(f"/api/v1/scans/{sid}/shoes/{extra}", headers=h)
    for v in ("right", "left", "sole"):
        await _put(c, h, sid, first, v)
    detail = (await c.get(f"/api/v1/scans/{sid}", headers=h)).json()["data"]
    assert (
        detail["canFinish"] is True
        and detail["shoes"][0]["complete"] is True
        and detail["shoes"][0]["status"] == "complete"
    )
    assert [p["view"] for p in detail["shoes"][0]["photos"]] == [
        "top",
        "right",
        "left",
        "sole",
    ]
    missing_photo = await c.delete(
        f"/api/v1/scans/{sid}/shoes/{first}/photos/top", headers=h
    )
    assert missing_photo.json()["data"]["shoes"][0]["missing"] == ["top"]
    await _put(c, h, sid, first, "top")
    fin = await c.post(f"/api/v1/scans/{sid}/finish", headers=h)
    assert (
        fin.status_code == 200
        and fin.json()["data"]["status"] == "processing"
        and fin.json()["data"]["finishedAt"]
    )
    locked = await c.post(f"/api/v1/scans/{sid}/shoes", headers=h)
    assert locked.status_code == 409 and locked.json()["code"] == "NOT_DRAFT"
    assert locked.json()["message"] == "Scan is processing; it can no longer be changed"


async def test_e20_delete_empty_draft_and_draft_limit(env: dict[str, Any]) -> None:
    c, h = env["c"], env["h"]
    sid = (await c.post("/api/v1/scans", headers=h)).json()["data"]["id"]
    await c.post(f"/api/v1/scans/{sid}/shoes", headers=h)
    full = await c.delete(f"/api/v1/scans/{sid}", headers=h)
    assert (
        full.status_code == 409
        and full.json()["code"] == "SCAN_NOT_EMPTY"
        and full.json()["details"] == {"shoeCount": 1}
    )
    shoe = (await c.get(f"/api/v1/scans/{sid}", headers=h)).json()["data"]["shoes"][0][
        "id"
    ]
    await c.delete(f"/api/v1/scans/{sid}/shoes/{shoe}", headers=h)
    gone = await c.delete(f"/api/v1/scans/{sid}", headers=h)
    assert gone.status_code == 204 and gone.content == b""
    assert (await c.get(f"/api/v1/scans/{sid}", headers=h)).status_code == 404

    # SCAN_MAX_OPEN_DRAFTS=3 in this app
    ids = [
        (await c.post("/api/v1/scans", headers=h)).json()["data"]["id"]
        for _ in range(3)
    ]
    fourth = await c.post("/api/v1/scans", headers=h)
    assert fourth.status_code == 409 and fourth.json()["code"] == "DRAFT_LIMIT_REACHED"
    for i in ids:
        await c.delete(f"/api/v1/scans/{i}", headers=h)


async def test_album_batch_partial_success(env: dict[str, Any]) -> None:
    c, h, storage = env["c"], env["h"], env["storage"]
    sid = (await c.post("/api/v1/scans", headers=h)).json()["data"]["id"]
    manifest = {
        "shoes": [
            {
                "ref": "a",
                "files": [
                    {"field": "f1", "view": "top"},
                    {"field": "f2", "view": "right"},
                ],
            },
            {"ref": "b", "files": [{"field": "f3", "view": "front"}]},
            {"ref": "c", "files": [{"field": "f4", "view": "top"}]},
        ]
    }
    r = await c.post(
        f"/api/v1/scans/{sid}/photos/batch",
        headers=h,
        data={"manifest": json.dumps(manifest)},
        files=[("f1", ("a.jpg", JPEG)), ("f2", ("b.png", PNG)), ("f4", ("c.gif", GIF))],
    )
    assert r.status_code == 200, r.text
    results = r.json()["data"]["results"]
    assert [x["ref"] for x in results] == ["a", "b", "c"]
    assert (
        results[0]["saved"] is True
        and results[0]["label"] == "Shoe 01"
        and results[0]["missing"] == ["left", "sole"]
    )
    assert results[1] == {
        "ref": "b",
        "saved": False,
        "error": "INVALID_VIEW",
        "detail": "unknown view 'front'",
    }
    assert results[2] == {
        "ref": "c",
        "saved": False,
        "error": "UNSUPPORTED_TYPE",
        "detail": "file 'f4'",
    }
    sess = r.json()["data"]["session"]
    assert (
        sess["source"] == "album"
        and len(sess["shoes"]) == 1
        and len(storage.objects) == 2
    )

    nomanifest = await c.post(
        f"/api/v1/scans/{sid}/photos/batch", headers=h, data={"x": "1"}
    )
    assert nomanifest.json()["message"] == [
        "property x should not exist",
        "manifest must be shorter than or equal to 8192 characters",
        "manifest must be a string",
    ]
    badjson = await c.post(
        f"/api/v1/scans/{sid}/photos/batch", headers=h, data={"manifest": "{bad"}
    )
    assert badjson.json()["code"] == "INVALID_MANIFEST"
    dup = await c.post(
        f"/api/v1/scans/{sid}/photos/batch",
        headers=h,
        data={
            "manifest": json.dumps(
                {"shoes": [{"ref": "a", "files": [{"field": "f1", "view": "top"}]}]}
            )
        },
        files=[("f1", ("a.jpg", JPEG)), ("f1", ("b.jpg", JPEG))],
    )
    assert dup.status_code == 400 and dup.json()["code"] == "DUPLICATE_FILE_FIELD"
    toomany = await c.post(
        f"/api/v1/scans/{sid}/photos/batch",
        headers=h,
        data={
            "manifest": json.dumps(
                {
                    "shoes": [
                        {"ref": f"s{i}", "files": [{"field": f"f{i}", "view": "top"}]}
                        for i in range(4)
                    ]
                }
            )
        },
    )
    assert toomany.status_code == 413 and toomany.json()["code"] == "BATCH_TOO_LARGE"


async def test_storage_failure_and_abandon(env: dict[str, Any]) -> None:
    c, h, storage, app = env["c"], env["h"], env["storage"], env["app"]
    sid = (await c.post("/api/v1/scans", headers=h)).json()["data"]["id"]
    shoe = (await c.post(f"/api/v1/scans/{sid}/shoes", headers=h)).json()["data"][
        "shoes"
    ][0]["id"]
    storage.fail_put = True
    try:
        r = await _put(c, h, sid, shoe, "top")
    finally:
        storage.fail_put = False
    assert r.status_code == 502 and r.json()["code"] == "STORAGE_UNAVAILABLE"
    assert (await c.get(f"/api/v1/scans/{sid}", headers=h)).json()["data"]["shoes"][0][
        "photos"
    ] == []

    await _put(c, h, sid, shoe, "top")
    assert len(storage.objects) == 1
    from datetime import timedelta

    from app.core.time import utcnow

    svc: ScanService = app.state.scans
    assert await svc.abandon_stale_drafts(now=utcnow()) == 0  # not idle yet
    n = await svc.abandon_stale_drafts(now=utcnow() + timedelta(days=31))
    assert n >= 1 and storage.objects == {}
    gone = await c.get(f"/api/v1/scans/{sid}", headers=h)
    assert (
        gone.json()["data"]["status"] == "abandoned"
        and gone.json()["data"]["shoes"][0]["photos"] == []
    )
    assert (await c.post(f"/api/v1/scans/{sid}/shoes", headers=h)).json()[
        "code"
    ] == "NOT_DRAFT"
    # E20 may delete an abandoned scan once its shoes are gone
    shoe_del = await c.delete(f"/api/v1/scans/{sid}/shoes/{shoe}", headers=h)
    assert shoe_del.status_code == 409  # not a draft: shoes cannot be edited

    unconfigured = MemoryPhotoStorage(configured=False)
    app.state.scans = ScanService(
        app.state.settings, app.state.session_factory, unconfigured
    )
    r503 = await c.post("/api/v1/scans", headers=h)
    assert r503.status_code == 503 and r503.json()["code"] == "STORAGE_NOT_CONFIGURED"
    app.state.scans = svc
