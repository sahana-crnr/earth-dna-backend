"""`/scans/...` F2 and F3 routes: E10 submit, E10b analyze, E11 results,
E12 confirm, E13 reject (scan-result / scan-analyze / scan-review controllers)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.params import user_uuid, uuid_param
from app.core.db import get_session
from app.core.ratelimit import ThrottledRoute, throttle
from app.core.security import JwtPayload, get_current_user
from app.core.validation import apply_transforms, read_json_body, validate_dict
from app.schemas.results import REJECT_SHOE, RESULTS_QUERY, SHOE_DETAILS, SUBMIT_RESULT

router = APIRouter(prefix="/scans", tags=["Scans"], route_class=ThrottledRoute)
scan_id_param = uuid_param("scanId")
shoe_id_param = uuid_param("shoeId")


async def _body(request: Request, schema: Any) -> dict[str, Any]:
    from app.core.errors import ValidationFailed

    data = await read_json_body(request)
    messages = validate_dict(data, schema.fields)
    if messages:
        raise ValidationFailed(messages)
    return apply_transforms(data, schema.fields)


def _query(request: Request, schema: Any) -> dict[str, Any]:
    from app.core.errors import ValidationFailed

    data = dict(request.query_params.items())
    messages = validate_dict(data, schema.fields)
    if messages:
        raise ValidationFailed(messages)
    return apply_transforms(data, schema.fields)


@router.post(
    "/{scanId}/shoes/{shoeId}/result", summary="E10 — submit the on-device result"
)
@throttle(30, 60000)
async def submit_result(
    request: Request,
    response: Response,
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    body = await _body(request, SUBMIT_RESULT)
    view = await request.app.state.results.submit(
        session, user_uuid(user["sub"]), scan_id, shoe_id, body
    )
    response.status_code = 200 if view["replaced"] else 201
    return view  # type: ignore[no-any-return]


@router.post(
    "/{scanId}/shoes/{shoeId}/analyze", summary="E10b — run ShoeDNA server-side"
)
@throttle(20, 60000)
async def analyze(
    request: Request,
    response: Response,
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    view = await request.app.state.analyze.analyze(
        session, user_uuid(user["sub"]), scan_id, shoe_id
    )
    response.status_code = 200 if view["replaced"] else 201
    return view  # type: ignore[no-any-return]


@router.get("/{scanId}/results", summary="E11 — per-shoe identification status")
@throttle(120, 60000)
async def results(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    q = _query(request, RESULTS_QUERY)
    return await request.app.state.results.results(  # type: ignore[no-any-return]
        session, user_uuid(user["sub"]), scan_id, q.get("include") == "raw"
    )


@router.post(
    "/{scanId}/shoes/{shoeId}/confirm",
    status_code=201,
    summary="E12 — confirm the prediction",
)
@throttle(30, 60000)
async def confirm(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    body = await _body(request, SHOE_DETAILS)
    return await request.app.state.review.confirm(  # type: ignore[no-any-return]
        session, user_uuid(user["sub"]), scan_id, shoe_id, body
    )


@router.post(
    "/{scanId}/shoes/{shoeId}/reject",
    status_code=201,
    summary="E13 — reject the prediction",
)
@throttle(30, 60000)
async def reject(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    body = await _body(request, REJECT_SHOE)
    return await request.app.state.review.reject(  # type: ignore[no-any-return]
        session, user_uuid(user["sub"]), scan_id, shoe_id, body
    )
