"""F2 → F3 → F4-F7 end to end against the database (PY_IT_DB=1): submit a
result, review it into My Shoes, then exercise the profile, list, summary,
edit, share, photos, feedback, rescan and remove routes; plus the admin
integrations routes."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, insert, update

from app.main import build_services, create_app
from app.models import CatalogBrand, CatalogSize, User
from app.services.storage import MemoryPhotoStorage
from tests.conftest import make_settings, requires_db

pytestmark = [requires_db, pytest.mark.db]

RUN = uuid.uuid4().hex[:6]
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
async def env() -> AsyncIterator[dict[str, Any]]:
    settings = make_settings(MAIL_DRY_RUN=True, SHOE_PHOTOS_BUCKET="test-bucket")
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        storage = MemoryPhotoStorage()
        build_services(app, settings, app.state.session_factory, storage=storage)
        brand_id = uuid.uuid4()
        async with app.state.engine.begin() as conn:
            await conn.execute(
                insert(CatalogBrand).values(
                    id=brand_id,
                    slug=f"zz-rev-{RUN}",
                    name=f"Zz Rev {RUN}",
                    sortOrder=0,
                    isActive=True,
                )
            )
            await conn.execute(
                insert(CatalogSize).values(
                    brandId=brand_id, system="US", label="9", sortOrder=0
                )
            )
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://t"
        ) as c:
            tokens: dict[str, str] = {}
            for who in ("u", "admin"):
                reg = await c.post(
                    "/api/v1/auth/register",
                    json={
                        "fullName": who,
                        "email": f"rev-{who}-{RUN}@pyflow.test",
                        "password": "Passw0rd!xyz",
                        "country": "US",
                    },
                )
                tokens[who] = reg.json()["data"]["accessToken"]
            async with app.state.engine.begin() as conn:
                await conn.execute(
                    update(User)
                    .where(User.email == f"rev-admin-{RUN}@pyflow.test")
                    .values(role="ADMIN")
                )
            try:
                yield {
                    "app": app,
                    "c": c,
                    "h": {"Authorization": f"Bearer {tokens['u']}"},
                    "admin": {"Authorization": f"Bearer {tokens['admin']}"},
                    "storage": storage,
                    "brand": str(brand_id),
                }
            finally:
                async with app.state.engine.begin() as conn:
                    await conn.execute(
                        delete(User).where(User.email.like(f"rev-%-{RUN}@pyflow.test"))
                    )
                    await conn.execute(
                        delete(CatalogBrand).where(CatalogBrand.id == brand_id)
                    )


async def _finished_scan(c: AsyncClient, h: dict[str, str]) -> tuple[str, str]:
    sid = (await c.post("/api/v1/scans", headers=h)).json()["data"]["id"]
    shoe = (await c.post(f"/api/v1/scans/{sid}/shoes", headers=h)).json()["data"][
        "shoes"
    ][0]["id"]
    for v in ("top", "right", "left", "sole"):
        r = await c.put(
            f"/api/v1/scans/{sid}/shoes/{shoe}/photos/{v}",
            headers=h,
            files={"file": ("p.jpg", JPEG)},
        )
        assert r.status_code == 200, r.text
    fin = await c.post(f"/api/v1/scans/{sid}/finish", headers=h)
    assert fin.status_code == 200
    return sid, shoe


async def test_results_flow(env: dict[str, Any]) -> None:
    c, h = env["c"], env["h"]
    draft = (await c.post("/api/v1/scans", headers=h)).json()["data"]["id"]
    dshoe = (await c.post(f"/api/v1/scans/{draft}/shoes", headers=h)).json()["data"][
        "shoes"
    ][0]["id"]
    nd = await c.post(
        f"/api/v1/scans/{draft}/shoes/{dshoe}/result",
        headers=h,
        json={"modelVersion": "v1", "brand": "Nike", "confidence": 0.9},
    )
    assert nd.status_code == 409 and nd.json()["code"] == "NOT_PROCESSING"
    assert (
        nd.json()["message"]
        == "Scan is still a draft; call /finish before submitting results"
    )

    sid, shoe = await _finished_scan(c, h)
    waiting = (await c.get(f"/api/v1/scans/{sid}/results", headers=h)).json()["data"]
    assert waiting["status"] == "processing" and waiting["allResolved"] is False
    assert (
        waiting["shoes"][0]["status"] == "waiting"
        and waiting["shoes"][0]["result"] is None
    )
    assert waiting["shoes"][0]["suggested"] == {"brandId": None, "brand": None}

    bad = await c.post(
        f"/api/v1/scans/{sid}/shoes/{shoe}/result",
        headers=h,
        json={
            "modelVersion": "v 1!",
            "brand": "Nike",
            "confidence": 2,
            "candidates": [{"brand": "x", "confidence": "a"}],
            "outcome": "maybe",
            "conditionCode": "C9",
        },
    )
    assert bad.json()["message"] == [
        "modelVersion may contain letters, digits and . _ @ / -",
        "outcome must be one of the following values: identified, failed",
        "confidence must not be greater than 1",
        "conditionCode must be one of the following values: C1, C2, C3, C4, C5",
        "candidates.0.confidence must not be greater than 1",
        "candidates.0.confidence must not be less than 0",
        "candidates.0.confidence must be a number conforming to the specified constraints",
    ]
    inc = await c.post(
        f"/api/v1/scans/{sid}/shoes/{shoe}/result",
        headers=h,
        json={"modelVersion": "v1"},
    )
    assert inc.json()["code"] == "RESULT_INCOMPLETE" and inc.json()["details"] == {
        "missing": ["brand", "confidence"]
    }
    deep = await c.post(
        f"/api/v1/scans/{sid}/shoes/{shoe}/result",
        headers=h,
        json={
            "modelVersion": "v1",
            "brand": "Nike",
            "confidence": 0.5,
            "raw": {"a": {"b": {"c": {"d": {"e": {"f": {"g": 1}}}}}}},
        },
    )
    assert deep.json()["code"] == "RAW_TOO_DEEP"

    ok = await c.post(
        f"/api/v1/scans/{sid}/shoes/{shoe}/result",
        headers=h,
        json={
            "modelVersion": "shoedna-tflite-1.4.2",
            "brand": f"Zz Rev {RUN}",
            "model": "Runner",
            "colorway": "Black",
            "confidence": 0.92345,
            "conditionCode": "C2",
            "candidates": [
                {"brand": "Nike", "model": "Air", "confidence": 0.92345},
                {"brand": "Adidas", "confidence": 0.05},
            ],
            "raw": {"embeddingVersion": "v3"},
            "category": "Running Shoes",
        },
    )
    assert ok.status_code == 201, ok.text
    d = ok.json()["data"]
    assert (
        d["replaced"] is False
        and d["status"] == "identified"
        and d["scanStatus"] == "review"
    )
    r = d["result"]
    assert (
        r["confidence"] == 0.9235
        and r["matchPercent"] == 92
        and r["condition"] == {"code": "C2", "label": "Lightly Worn"}
    )
    assert r["candidates"] == [
        {"brand": "Nike", "model": "Air", "confidence": 0.9235},
        {"brand": "Adidas", "model": None, "confidence": 0.05},
    ]
    assert r["raw"] == {"embeddingVersion": "v3"} and r["submittedAt"].endswith("Z")

    again = await c.post(
        f"/api/v1/scans/{sid}/shoes/{shoe}/result",
        headers=h,
        json={"modelVersion": "v2", "outcome": "failed"},
    )
    assert (
        again.status_code == 200
        and again.json()["data"]["replaced"] is True
        and again.json()["data"]["status"] == "failed"
    )
    res = (await c.get(f"/api/v1/scans/{sid}/results", headers=h)).json()["data"]
    assert (
        res["status"] == "review"
        and res["allResolved"] is True
        and "raw" not in res["shoes"][0]["result"]
    )
    raw = (
        await c.get(
            f"/api/v1/scans/{sid}/results", headers=h, params={"include": "raw"}
        )
    ).json()["data"]
    assert raw["shoes"][0]["result"]["raw"] is None
    badq = await c.get(
        f"/api/v1/scans/{sid}/results", headers=h, params={"include": "x"}
    )
    assert badq.json()["message"] == [
        "include must be one of the following values: raw"
    ]

    an = await c.post(f"/api/v1/scans/{sid}/shoes/{shoe}/analyze", headers=h)
    assert an.status_code == 503 and an.json()["code"] == "INFERENCE_NOT_CONFIGURED"

    # review: failed result → brand required; then confirm with the catalog brand
    nob = await c.post(f"/api/v1/scans/{sid}/shoes/{shoe}/confirm", headers=h, json={})
    assert nob.json()["code"] == "BRAND_REQUIRED"
    rej = await c.post(f"/api/v1/scans/{sid}/shoes/{shoe}/reject", headers=h, json={})
    assert (
        rej.json()["message"][0] == "brandId must be a UUID"
        and len(rej.json()["message"]) == 8
    )
    badb = await c.post(
        f"/api/v1/scans/{sid}/shoes/{shoe}/confirm",
        headers=h,
        json={"brandId": "00000000-0000-4000-8000-000000000000"},
    )
    assert badb.json()["code"] == "UNKNOWN_BRAND"
    bads = await c.post(
        f"/api/v1/scans/{sid}/shoes/{shoe}/confirm",
        headers=h,
        json={
            "brandId": env["brand"],
            "sizeId": "00000000-0000-4000-8000-000000000000",
        },
    )
    assert bads.json()["code"] == "UNKNOWN_SIZE"
    size_id = (
        await c.get(
            "/api/v1/catalog/sizes", headers=h, params={"brandId": env["brand"]}
        )
    ).json()["data"]["items"][0]["id"]
    conf = await c.post(
        f"/api/v1/scans/{sid}/shoes/{shoe}/confirm",
        headers=h,
        json={
            "brandId": env["brand"],
            "model": "Runner",
            "color": "Black",
            "sizeId": size_id,
            "gender": "men",
        },
    )
    assert conf.status_code == 201, conf.text
    cd = conf.json()["data"]
    assert cd["status"] == "completed" and cd["reviewed"] == {"done": 1, "total": 1}
    entry = cd["shoes"][0]
    assert (
        entry["review"] == "confirmed"
        and entry["myShoeId"]
        and entry["myShoe"]["brand"]["name"] == f"Zz Rev {RUN}"
    )
    assert (
        entry["myShoe"]["size"]["label"] == "9" and entry["myShoe"]["gender"] == "men"
    )
    assert (
        entry["myShoe"]["thumbnailUrl"].startswith("memory://")
        and entry["myShoe"]["valueSource"] == "static"
    )
    again_c = await c.post(
        f"/api/v1/scans/{sid}/shoes/{shoe}/confirm", headers=h, json={}
    )
    assert again_c.status_code == 409 and again_c.json()["code"] == "ALREADY_REVIEWED"
    assert again_c.json()["details"] == {
        "review": "confirmed",
        "myShoeId": entry["myShoeId"],
    }
    env["my_shoe"] = entry["myShoeId"]

    # ── F4-F7 ─────────────────────────────────────────────────────────────
    my = entry["myShoeId"]
    lst = (await c.get("/api/v1/shoes", headers=h, params={"limit": 2})).json()["data"]
    assert (
        lst["total"] >= 1
        and lst["items"][0]["id"] == my
        and set(lst["items"][0]) >= {"actionTaken", "resaleBucket", "thumbnailUrl"}
    )
    badl = await c.get(
        "/api/v1/shoes?actionTaken=nope,none&condition=x&limit=0&foo=1", headers=h
    )
    assert badl.json()["message"] == [
        "property foo should not exist",
        "each value in actionTaken must be one of the following values: none, resold, repaired, donated, recycled",
        "each value in condition must be one of the following values: like_new, lightly_worn, heavily_worn, not_wearable",
        "limit must not be less than 1",
    ]
    summ = (await c.get("/api/v1/shoes/summary", headers=h)).json()["data"]
    assert summ["pairsScanned"] >= 1 and (
        summ["potentialValue"] is None or summ["potentialValue"]["currency"] == "USD"
    )

    prof = (await c.get(f"/api/v1/shoes/{my}", headers=h)).json()["data"]
    # the last submitted result was "failed" (no grade), so the entry has none
    assert prof["id"] == my and prof["condition"]["code"] is None
    assert prof["condition"]["label"] is None and prof["condition"]["grade"] is None
    assert [p["source"] for p in prof["photos"]] == ["scan"] * 4 and prof["photos"][1][
        "isPrimary"
    ] is True  # right view preferred
    assert prof["materials"][0]["part"] == "upper" and prof["circularSort"] == {
        "status": "pending"
    }
    assert (
        prof["share"] == {"active": False, "url": None, "createdAt": None}
        and prof["rescan"] is None
    )
    assert prof["scan"]["scanId"] == sid

    assert (await c.patch(f"/api/v1/shoes/{my}", headers=h, json={})).json()[
        "code"
    ] == "EMPTY_UPDATE"
    badp = await c.patch(
        f"/api/v1/shoes/{my}",
        headers=h,
        json={
            "brandId": "x",
            "sizeId": "y",
            "gender": "z",
            "actionTaken": "w",
            "model": 5,
            "color": None,
            "primaryPhotoId": None,
            "shoeTypeId": "q",
            "foo": 1,
        },
    )
    assert badp.json()["message"] == [
        "property foo should not exist",
        "brandId must be a UUID",
        "model must be shorter than or equal to 150 characters",
        "model must be a string",
        "sizeId must be a UUID",
        "shoeTypeId must be a UUID",
        "gender must be one of the following values: men, women, unisex, kids",
        "actionTaken must be one of the following values: none, resold, repaired, donated, recycled",
        "primaryPhotoId must be a UUID",
    ]
    ed = (
        await c.patch(
            f"/api/v1/shoes/{my}",
            headers=h,
            json={"model": "  Runner 95 ", "actionTaken": "resold", "color": None},
        )
    ).json()["data"]
    assert (
        ed["model"] == "Runner 95"
        and ed["color"] is None
        and ed["actionTaken"] == "resold"
        and ed["actionTakenAt"]
    )
    types = (await c.get("/api/v1/catalog/categories", headers=h)).json()["data"][
        "items"
    ]
    ed2 = (
        await c.patch(
            f"/api/v1/shoes/{my}",
            headers=h,
            json={"shoeTypeId": types[3]["id"], "sizeId": None},
        )
    ).json()["data"]
    assert ed2["shoeType"]["name"] == "Boots" and ed2["size"] == {
        "id": None,
        "label": None,
    }
    assert ed2["materials"][0]["material"] == "Leather / Nubuck"

    sh = await c.post(f"/api/v1/shoes/{my}/share", headers=h)
    assert sh.status_code == 201 and sh.json()["data"]["url"].endswith(
        "/s/" + sh.json()["data"]["token"]
    )
    assert sh.json()["data"]["url"].startswith("http://t/api/v1/s/runner-95-")
    assert (await c.post(f"/api/v1/shoes/{my}/share", headers=h)).status_code == 200
    token = sh.json()["data"]["token"]
    pub = await c.get(f"/api/v1/s/{token}", headers={"Accept": "application/json"})
    assert (
        pub.status_code == 200
        and pub.headers["cache-control"] == "no-store"
        and pub.headers["x-robots-tag"] == "noindex"
    )
    assert (
        pub.json()["data"]["brand"] == f"Zz Rev {RUN}"
        and pub.json()["data"]["model"] == "Runner 95"
        and pub.json()["data"]["shoeType"] == "Boots"
    )
    page = await c.get(f"/api/v1/s/{token}")
    assert (
        page.status_code == 200
        and page.headers["content-type"].startswith("text/html")
        and "<title>" in page.text
    )
    assert page.headers["content-security-policy"].startswith("default-src 'none'")
    nf = await c.get("/api/v1/s/nope-token", headers={"Accept": "application/json"})
    assert (
        nf.status_code == 404
        and nf.json()["code"] == "SHARE_NOT_FOUND"
        and set(nf.json()) == {"statusCode", "code", "message", "timestamp", "path"}
    )
    nfh = await c.get("/api/v1/s/nope-token")
    assert nfh.status_code == 404 and "no longer shared" in nfh.text
    assert (await c.delete(f"/api/v1/shoes/{my}/share", headers=h)).status_code == 204
    assert (
        await c.get(f"/api/v1/s/{token}", headers={"Accept": "application/json"})
    ).status_code == 404

    fb = await c.post(
        f"/api/v1/shoes/{my}/condition-feedback",
        headers=h,
        json={"suggestedConditionCode": "C9", "reason": "  "},
    )
    assert fb.json()["message"] == [
        "suggestedConditionCode must be one of the following values: C1, C2, C3, C4, C5",
        "reason must be longer than or equal to 1 characters",
    ]
    fbo = await c.post(
        f"/api/v1/shoes/{my}/condition-feedback",
        headers=h,
        json={"suggestedConditionCode": "C3", "reason": "  sole worn  "},
    )
    assert fbo.status_code == 201 and fbo.json()["data"]["reason"] == "sole worn"
    assert (await c.get(f"/api/v1/shoes/{my}", headers=h)).json()["data"][
        "conditionFeedback"
    ]["suggestedConditionCode"] == "C3"

    nofile = await c.post(f"/api/v1/shoes/{my}/photos", headers=h)
    assert nofile.json()["code"] == "FILE_REQUIRED"
    added = await c.post(
        f"/api/v1/shoes/{my}/photos", headers=h, files={"file": ("b.png", PNG)}
    )
    assert added.status_code == 201
    photos = added.json()["data"]["photos"]
    upload = next(p for p in photos if p["source"] == "upload")
    scan_photo = next(p for p in photos if p["source"] == "scan")
    assert upload["sortOrder"] == 4
    fixed = await c.delete(f"/api/v1/shoes/{my}/photos/{scan_photo['id']}", headers=h)
    assert fixed.status_code == 409 and fixed.json()["code"] == "SCAN_PHOTO_FIXED"
    prim = (
        await c.patch(
            f"/api/v1/shoes/{my}", headers=h, json={"primaryPhotoId": upload["id"]}
        )
    ).json()["data"]
    assert (
        next(p for p in prim["photos"] if p["id"] == upload["id"])["isPrimary"] is True
    )
    gone = await c.delete(f"/api/v1/shoes/{my}/photos/{upload['id']}", headers=h)
    assert gone.status_code == 200 and all(
        p["source"] == "scan" for p in gone.json()["data"]["photos"]
    )
    assert any(p["isPrimary"] for p in gone.json()["data"]["photos"])  # promoted
    assert (
        await c.delete(f"/api/v1/shoes/{my}/photos/{upload['id']}", headers=h)
    ).json()["code"] == "PHOTO_NOT_FOUND"

    rs = await c.post(f"/api/v1/shoes/{my}/rescan", headers=h)
    assert (
        rs.status_code == 201
        and rs.json()["data"]["created"] is True
        and rs.json()["data"]["status"] == "draft"
    )
    rs2 = await c.post(f"/api/v1/shoes/{my}/rescan", headers=h)
    assert (
        rs2.status_code == 200
        and rs2.json()["data"]["scanId"] == rs.json()["data"]["scanId"]
    )
    assert (await c.get(f"/api/v1/shoes/{my}", headers=h)).json()["data"]["rescan"][
        "scanId"
    ] == rs.json()["data"]["scanId"]

    # complete the rescan: upload 4 views, finish, submit, confirm → entry updated in place
    rsid, rshoe = rs.json()["data"]["scanId"], rs.json()["data"]["shoeId"]
    for v in ("top", "right", "left", "sole"):
        await c.put(
            f"/api/v1/scans/{rsid}/shoes/{rshoe}/photos/{v}",
            headers=h,
            files={"file": ("p.png", PNG)},
        )
    await c.post(f"/api/v1/scans/{rsid}/finish", headers=h)
    await c.post(
        f"/api/v1/scans/{rsid}/shoes/{rshoe}/result",
        headers=h,
        json={
            "modelVersion": "v3",
            "brand": f"Zz Rev {RUN}",
            "model": "Runner 2",
            "confidence": 0.7,
            "conditionCode": "C3",
        },
    )
    done = await c.post(
        f"/api/v1/scans/{rsid}/shoes/{rshoe}/confirm", headers=h, json={}
    )
    assert done.status_code == 201, done.text
    assert done.json()["data"]["shoes"][0]["myShoeId"] == my
    after = (await c.get(f"/api/v1/shoes/{my}", headers=h)).json()["data"]
    assert (
        after["model"] == "Runner 2"
        and after["condition"]["code"] == "C3"
        and after["scan"]["scanId"] == rsid
    )
    assert (
        all(p["source"] == "scan" for p in after["photos"])
        and len(after["photos"]) == 4
    )
    assert after["rescan"] is None
    hidden_old = await c.get("/api/v1/scans", headers=h, params={"limit": 50})
    assert sid not in [
        s["id"] for s in hidden_old.json()["data"]["items"]
    ]  # origin scan hidden

    # remove
    assert (await c.delete(f"/api/v1/shoes/{my}", headers=h)).status_code == 204
    assert (await c.get(f"/api/v1/shoes/{my}", headers=h)).status_code == 404
    assert (await c.get("/api/v1/shoes/summary", headers=h)).json()["data"][
        "pairsScanned"
    ] == 0


async def test_admin_integrations(env: dict[str, Any]) -> None:
    c, h, admin = env["c"], env["h"], env["admin"]
    denied = await c.get("/api/v1/admin/integrations", headers=h)
    assert denied.status_code == 403 and denied.json()["code"] == "FORBIDDEN_ROLE"
    lst = await c.get("/api/v1/admin/integrations", headers=admin)
    assert lst.status_code == 200 and [
        i["name"] for i in lst.json()["data"]["items"]
    ] == ["shoedna", "valuelens"]
    assert set(lst.json()["data"]["items"][0]) == {
        "name",
        "baseUrl",
        "version",
        "authRef",
        "enabled",
        "updatedAt",
        "updatedBy",
    }
    bad = await c.put(
        "/api/v1/admin/integrations/shoedna",
        headers=admin,
        json={
            "baseUrl": "http://x.test",
            "version": "",
            "authRef": "nope",
            "enabled": "yes",
            "x": 1,
        },
    )
    assert (
        bad.status_code == 400
        and bad.json()["message"][0] == "property x should not exist"
    )
    assert (
        "baseUrl must be an https URL without credentials, query string or fragment"
        in bad.json()["message"]
    )
    unknown = await c.put("/api/v1/admin/integrations/other", headers=admin, json={})
    assert unknown.status_code == 404 and unknown.json()["details"] == {
        "known": ["shoedna", "valuelens"]
    }
    inc = await c.put(
        "/api/v1/admin/integrations/shoedna", headers=admin, json={"enabled": True}
    )
    assert inc.status_code == 409 and inc.json()["code"] == "INTEGRATION_INCOMPLETE"
    ok = await c.put(
        "/api/v1/admin/integrations/shoedna",
        headers=admin,
        json={
            "baseUrl": "https://shoedna.example.test/v2",
            "version": "2026.1",
            "authRef": f"earthdna/be/test-{RUN}",
        },
    )
    assert (
        ok.status_code == 200
        and ok.json()["data"]["enabled"] is False
        and ok.json()["data"]["updatedBy"]["email"] == f"rev-admin-{RUN}@pyflow.test"
    )
    cleared = await c.put(
        "/api/v1/admin/integrations/shoedna",
        headers=admin,
        json={"baseUrl": None, "version": None, "authRef": None},
    )
    assert (
        cleared.json()["data"]["baseUrl"] is None
        and cleared.json()["data"]["version"] is None
    )
