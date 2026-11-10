"""Catalog lists and resolution against the database (PY_IT_DB=1), ported from
catalog.service.it.spec.ts. Seeds its own brands/products and cleans up."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, insert

from app.main import create_app
from app.models import CatalogBrand, CatalogProduct, CatalogSize
from app.repositories import catalog as repo
from tests.conftest import make_settings, requires_db

pytestmark = [requires_db, pytest.mark.db]

RUN = uuid.uuid4().hex[:6]


@pytest.fixture
async def seeded() -> AsyncIterator[dict[str, Any]]:
    settings = make_settings(MAIL_DRY_RUN=True)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        engine = app.state.engine
        b_active, b_inactive, b_nosize = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        async with engine.begin() as conn:
            await conn.execute(
                insert(CatalogBrand).values(
                    [
                        {
                            "id": b_active,
                            "slug": f"zz-alpha-{RUN}",
                            "name": f"Zz Alpha {RUN}",
                            "sortOrder": 0,
                            "isActive": True,
                        },
                        {
                            "id": b_inactive,
                            "slug": f"zz-beta-{RUN}",
                            "name": f"Zz Beta {RUN}",
                            "sortOrder": 1,
                            "isActive": False,
                        },
                        {
                            "id": b_nosize,
                            "slug": f"zz-gamma-{RUN}",
                            "name": f"Zz Gamma {RUN}",
                            "sortOrder": 2,
                            "isActive": True,
                        },
                    ]
                )
            )
            await conn.execute(
                insert(CatalogSize).values(
                    [
                        {
                            "brandId": b_active,
                            "system": "US",
                            "label": "10",
                            "sortOrder": 0,
                        },
                        {
                            "brandId": b_active,
                            "system": "US",
                            "label": "7.5",
                            "sortOrder": 1,
                        },
                        {
                            "brandId": b_active,
                            "system": "US",
                            "label": "8",
                            "sortOrder": 2,
                        },
                    ]
                )
            )
            await conn.execute(
                insert(CatalogProduct).values(
                    [
                        {
                            "brandId": b_active,
                            "sku": f"S1-{RUN}",
                            "model": "Runner One",
                            "modelCode": "R1-B",
                            "colour": "Black/White",
                            "size": "8",
                            "msrp": 100,
                            "isActive": True,
                        },
                        {
                            "brandId": b_active,
                            "sku": f"S2-{RUN}",
                            "model": "Runner One",
                            "modelCode": "R1-A",
                            "colour": "Red",
                            "size": "10",
                            "msrp": None,
                            "isActive": True,
                        },
                        {
                            "brandId": b_active,
                            "sku": f"S3-{RUN}",
                            "model": "Walker",
                            "modelCode": None,
                            "colour": "Black",
                            "size": "8",
                            "msrp": 80,
                            "isActive": True,
                        },
                        {
                            "brandId": b_active,
                            "sku": f"S4-{RUN}",
                            "model": "Hidden",
                            "modelCode": None,
                            "colour": "Green",
                            "size": "8",
                            "msrp": None,
                            "isActive": False,
                        },
                        {
                            "brandId": b_active,
                            "sku": f"S5-{RUN}",
                            "model": None,
                            "modelCode": None,
                            "colour": None,
                            "size": "8",
                            "msrp": None,
                            "isActive": True,
                        },
                    ]
                )
            )
        # a fresh database has no generic size list (the seed script adds it);
        # plant a short one so the fallback path is observable
        from sqlalchemy import select

        async with engine.begin() as conn:
            have_generic = (
                await conn.execute(
                    select(CatalogSize.id)
                    .where(CatalogSize.brand_id.is_(None))
                    .limit(1)
                )
            ).first()
            planted_generic = have_generic is None
            if planted_generic:
                await conn.execute(
                    insert(CatalogSize).values(
                        [
                            {
                                "brandId": None,
                                "system": "US",
                                "label": lbl,
                                "sortOrder": i,
                            }
                            for i, lbl in enumerate(["4", "4.5", "5", "5.5"])
                        ]
                    )
                )
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://t"
            ) as c:
                reg = await c.post(
                    "/api/v1/auth/register",
                    json={
                        "fullName": "Cat",
                        "email": f"cat-{RUN}@pyflow.test",
                        "password": "Passw0rd!xyz",
                        "country": "US",
                    },
                )
                token = reg.json()["data"]["accessToken"]
                yield {
                    "app": app,
                    "client": c,
                    "h": {"Authorization": f"Bearer {token}"},
                    "active": b_active,
                    "inactive": b_inactive,
                    "nosize": b_nosize,
                }
        finally:
            async with engine.begin() as conn:
                await conn.execute(
                    delete(CatalogBrand).where(CatalogBrand.slug.like(f"zz-%-{RUN}"))
                )
                if planted_generic:
                    await conn.execute(
                        delete(CatalogSize).where(CatalogSize.brand_id.is_(None))
                    )
                from app.models import User

                await conn.execute(
                    delete(User).where(User.email == f"cat-{RUN}@pyflow.test")
                )


async def test_e14_brands_active_prefix_escaped(seeded: dict[str, Any]) -> None:
    c, h = seeded["client"], seeded["h"]
    r = await c.get("/api/v1/catalog/brands", params={"q": "Zz "}, headers=h)
    names = [b["name"] for b in r.json()["data"]["items"]]
    assert names == [f"Zz Alpha {RUN}", f"Zz Gamma {RUN}"]  # inactive hidden, A→Z
    assert set(r.json()["data"]["items"][0]) == {"id", "name", "slug"}
    assert r.headers["cache-control"] == "private, max-age=300"
    wild = await c.get("/api/v1/catalog/brands", params={"q": "%"}, headers=h)
    assert wild.json()["data"]["items"] == []
    under = await c.get("/api/v1/catalog/brands", params={"q": "_z"}, headers=h)
    assert under.json()["data"]["items"] == []


async def test_e15_sizes_per_brand_and_generic(seeded: dict[str, Any]) -> None:
    c, h = seeded["client"], seeded["h"]
    r = await c.get(
        "/api/v1/catalog/sizes", params={"brandId": str(seeded["active"])}, headers=h
    )
    d = r.json()["data"]
    assert [s["label"] for s in d["items"]] == ["7.5", "8", "10"] and d[
        "generic"
    ] is False
    g = await c.get(
        "/api/v1/catalog/sizes", params={"brandId": str(seeded["nosize"])}, headers=h
    )
    assert g.json()["data"]["generic"] is True
    assert [s["label"] for s in g.json()["data"]["items"]][:3] == ["4", "4.5", "5"]
    bad = await c.get("/api/v1/catalog/sizes", params={"brandId": "nope"}, headers=h)
    assert bad.status_code == 400 and bad.json()["message"] == [
        "brandId must be a UUID"
    ]


async def test_e16_shoe_types(seeded: dict[str, Any]) -> None:
    c, h = seeded["client"], seeded["h"]
    r = await c.get("/api/v1/catalog/categories", headers=h)
    items = r.json()["data"]["items"]
    assert [t["slug"] for t in items] == [
        "athletic-shoes",
        "casual-shoes",
        "dress-shoes",
        "boots",
        "sandals",
        "slippers",
    ]
    assert all(set(t) == {"id", "name", "slug", "categories"} for t in items)


async def test_e17_e18_models_colours(seeded: dict[str, Any]) -> None:
    c, h = seeded["client"], seeded["h"]
    bid = str(seeded["active"])
    m = await c.get("/api/v1/catalog/models", params={"brandId": bid}, headers=h)
    assert m.json()["data"]["items"] == [
        {"model": "Runner One", "modelCode": "R1-A"},
        {"model": "Walker", "modelCode": None},
    ]
    mq = await c.get(
        "/api/v1/catalog/models", params={"brandId": bid, "q": "run"}, headers=h
    )
    assert [x["model"] for x in mq.json()["data"]["items"]] == ["Runner One"]
    col = await c.get("/api/v1/catalog/colours", params={"brandId": bid}, headers=h)
    assert [x["colour"] for x in col.json()["data"]["items"]] == [
        "Black",
        "Black/White",
        "Red",
    ]
    one = await c.get(
        "/api/v1/catalog/colours",
        params={"brandId": bid, "model": "runner one"},
        headers=h,
    )
    assert [x["colour"] for x in one.json()["data"]["items"]] == ["Black/White", "Red"]
    missing = await c.get("/api/v1/catalog/colours", headers=h)
    assert missing.status_code == 400 and missing.json()["message"] == [
        "brandId must be a UUID"
    ]
    extra = await c.get(
        "/api/v1/catalog/models", params={"brandId": bid, "extra": "1"}, headers=h
    )
    assert extra.status_code == 400 and extra.json()["message"] == [
        "property extra should not exist"
    ]


async def test_options_and_mute(seeded: dict[str, Any]) -> None:
    c, h, app = seeded["client"], seeded["h"], seeded["app"]
    o = await c.get("/api/v1/catalog/options", headers=h)
    assert o.json()["data"] == {"genders": ["men", "women", "unisex", "kids"]}
    app.state.settings.CATALOG_MUTED_ENDPOINTS.append("options")
    try:
        m = await c.get("/api/v1/catalog/options", headers=h)
        assert m.status_code == 404 and m.json()["code"] == "ENDPOINT_MUTED"
        assert (
            m.json()["message"] == "catalog/options is not enabled on this environment"
        )
    finally:
        app.state.settings.CATALOG_MUTED_ENDPOINTS.remove("options")
    assert (await c.get("/api/v1/catalog/options")).status_code == 401


async def test_resolution_and_match_product(seeded: dict[str, Any]) -> None:
    app = seeded["app"]
    async with app.state.session_factory() as s:
        assert (await repo.brand_by_id(s, seeded["active"])) is not None
        assert (await repo.brand_by_id(s, seeded["inactive"])) is None
        assert (await repo.brand_by_name(s, f"ZZ ALPHA {RUN}")) is not None
        assert (await repo.brand_by_name(s, "")) is None
        many = await repo.brands_by_names(
            s, [f"zz alpha {RUN}", f"zz-gamma-{RUN}", None, f"zz beta {RUN}"]
        )
        assert set(many) == {f"zz-alpha-{RUN}", f"zz-gamma-{RUN}"}
        sizes = await repo.sizes_for_brand(s, seeded["active"], 500)
        eight = next(x for x in sizes if x.label == "8")
        assert (await repo.size_by_id(s, eight.id, seeded["active"])) is not None
        assert (
            await repo.size_by_id(s, eight.id, seeded["nosize"])
        ) is None  # scoped to brand
        assert (await repo.size_by_id(s, uuid.uuid4(), None)) is None

        assert (await repo.match_product(s, None, "Runner One", "black", "8")) is None
        assert (
            await repo.match_product(s, seeded["active"], None, "black", "8")
        ) is None
        assert (
            await repo.match_product(s, seeded["active"], "Runner One", None, None)
        ) is None
        best = await repo.match_product(
            s, seeded["active"], " runner one ", "black", None
        )
        assert (
            best is not None and best.sku == f"S1-{RUN}"
        )  # colour hit + msrp tie-break
        red = await repo.match_product(s, seeded["active"], "Runner One", None, "10")
        assert red is not None and red.sku == f"S2-{RUN}"
        assert (
            await repo.match_product(s, seeded["active"], "Hidden", "green", "8")
        ) is None
        st = await repo.shoe_type_for_category(s, "Chelsea Boots")
        assert st is not None and st.slug == "boots"
        assert (await repo.shoe_type_for_category(s, "network")) is None
        cm = await repo.condition_mappings(s)
        assert [m.code for m in cm] == ["C1", "C2", "C3", "C4", "C5"]
