"""`/catalog/*` — E14 to E19 (src/catalog/catalog.controller.ts).

JWT required on every route, 120 requests/min, `Cache-Control: private,
max-age=300`, and the four "mutable" routes answer 404 ENDPOINT_MUTED when
listed in CATALOG_MUTED_ENDPOINTS.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import ApiError
from app.core.ratelimit import ThrottledRoute, throttle
from app.core.security import JwtPayload, get_current_user
from app.core.validation import query_of
from app.schemas.catalog import (
    BRANDS_QUERY,
    COLOURS_QUERY,
    MODELS_QUERY,
    SIZES_QUERY,
    BrandsQuery,
    ColoursQuery,
    ModelsQuery,
    SizesQuery,
)
from app.services.catalog import CatalogService

CACHE = "private, max-age=300"


def cache_control(response: Response) -> None:
    response.headers["Cache-Control"] = CACHE


def muted(name: str) -> Callable[[Request], None]:
    """`CatalogMuteGuard`: 404 ENDPOINT_MUTED for a switched-off route."""

    def dependency(request: Request) -> None:
        if name in request.app.state.settings.CATALOG_MUTED_ENDPOINTS:
            raise ApiError(
                404,
                "ENDPOINT_MUTED",
                f"catalog/{name} is not enabled on this environment",
            )

    return dependency


def catalog_service(request: Request) -> CatalogService:
    return request.app.state.catalog  # type: ignore[no-any-return]


router = APIRouter(
    prefix="/catalog",
    tags=["Catalog"],
    route_class=ThrottledRoute,
    dependencies=[Depends(get_current_user), Depends(cache_control)],
)

public_router = APIRouter(
    prefix="/catalog",
    tags=["Catalog"],
    route_class=ThrottledRoute,
    dependencies=[Depends(cache_control)],
)


@public_router.get(
    "/preview", summary="Public marketplace / catalog preview for dashboard"
)
@throttle(120, 60000)
async def catalog_preview(
    session: AsyncSession = Depends(get_session),
    svc: CatalogService = Depends(catalog_service),
) -> dict[str, Any]:
    return await svc.list_products(session)



@router.get("/brands", summary="E14 — active brands, A→Z, optional prefix search")
@throttle(120, 60000)
async def brands(
    q: BrandsQuery = Depends(query_of(BRANDS_QUERY, BrandsQuery)),
    session: AsyncSession = Depends(get_session),
    svc: CatalogService = Depends(catalog_service),
) -> dict[str, Any]:
    return await svc.list_brands(session, q.q)


@router.get(
    "/sizes", summary="E15 — US sizes for a brand (?brandId=), generic list otherwise"
)
@throttle(120, 60000)
async def sizes(
    q: SizesQuery = Depends(query_of(SIZES_QUERY, SizesQuery)),
    session: AsyncSession = Depends(get_session),
    svc: CatalogService = Depends(catalog_service),
) -> dict[str, Any]:
    return await svc.list_sizes(session, q.brandId)


@router.get(
    "/categories",
    summary="E16 — shoe types with the product categories mapped under each",
    dependencies=[Depends(muted("categories"))],
)
@throttle(120, 60000)
async def categories(
    session: AsyncSession = Depends(get_session),
    svc: CatalogService = Depends(catalog_service),
) -> dict[str, Any]:
    return await svc.list_shoe_types(session)


@router.get(
    "/models",
    summary="E17 — distinct models for a brand, optional prefix search",
    dependencies=[Depends(muted("models"))],
)
@throttle(120, 60000)
async def models(
    q: ModelsQuery = Depends(query_of(MODELS_QUERY, ModelsQuery)),
    session: AsyncSession = Depends(get_session),
    svc: CatalogService = Depends(catalog_service),
) -> dict[str, Any]:
    return await svc.list_models(session, q.brandId, q.q)


@router.get(
    "/colours",
    summary="E18 — distinct colours for a brand, optionally one model",
    dependencies=[Depends(muted("colours"))],
)
@throttle(120, 60000)
async def colours(
    q: ColoursQuery = Depends(query_of(COLOURS_QUERY, ColoursQuery)),
    session: AsyncSession = Depends(get_session),
    svc: CatalogService = Depends(catalog_service),
) -> dict[str, Any]:
    return await svc.list_colours(session, q.brandId, q.model)


@router.get(
    "/options",
    summary="E19 — closed option lists (genders)",
    dependencies=[Depends(muted("options"))],
)
@throttle(120, 60000)
async def options(
    svc: CatalogService = Depends(catalog_service),
    _user: JwtPayload = Depends(get_current_user),
) -> dict[str, Any]:
    return svc.options()
