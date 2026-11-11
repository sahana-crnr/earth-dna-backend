"""`GET /api/v1` — the ECS health check target. Same text as Node."""

from __future__ import annotations

from fastapi import APIRouter

from app.core.ratelimit import ThrottledRoute

router = APIRouter(route_class=ThrottledRoute)

WELCOME = "Welcome to the Earth DNA API!"


@router.get("", include_in_schema=False)
@router.get("/", include_in_schema=False)
async def get_started() -> str:
    return WELCOME
