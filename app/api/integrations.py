"""`/admin/integrations` (src/integrations/integrations.controller.ts), ADMIN only."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import ValidationFailed
from app.core.ratelimit import ThrottledRoute, throttle
from app.core.security import JwtPayload, require_roles
from app.core.validation import apply_transforms, read_json_body, validate_dict
from app.schemas.integrations import UPDATE_INTEGRATION

router = APIRouter(
    prefix="/admin/integrations",
    tags=["Admin"],
    route_class=ThrottledRoute,
    dependencies=[Depends(require_roles("ADMIN"))],
)


@router.get(
    "", summary="Current ShoeDNA / ValueLens endpoint, version and enabled flag"
)
async def list_integrations(
    request: Request, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    return await request.app.state.integrations.list(session)  # type: ignore[no-any-return]


@router.put("/{name}", summary="Update endpoint / version / auth reference / enabled")
@throttle(20, 60000)
async def update_integration(
    name: str,
    request: Request,
    user: JwtPayload = Depends(require_roles("ADMIN")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    data = await read_json_body(request)
    messages = validate_dict(data, UPDATE_INTEGRATION.fields)
    if messages:
        raise ValidationFailed(messages)
    patch = apply_transforms(data, UPDATE_INTEGRATION.fields)
    return await request.app.state.integrations.update(  # type: ignore[no-any-return]
        session, name, patch, uuid.UUID(user["sub"])
    )
