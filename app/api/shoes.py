"""`/shoes` F4 to F7 routes E21 to E25, E27 to E32 and the public `/s/{token}` page."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.multipart import read_multipart
from app.api.params import user_uuid, uuid_param
from app.core.db import get_session
from app.core.errors import ValidationFailed, request_path
from app.core.ratelimit import ThrottledRoute, throttle
from app.core.security import JwtPayload, get_current_user
from app.core.time import now_iso
from app.core.validation import apply_transforms, read_json_body, validate_dict
from app.schemas.shoes import CONDITION_FEEDBACK, LIST_SHOES_QUERY, UPDATE_SHOE
from app.services.share_page import NOT_FOUND_HTML, render_share_html
from app.services.shoe_rules import share_url

router = APIRouter(prefix="/shoes", tags=["Shoes"], route_class=ThrottledRoute)
public = APIRouter(prefix="/s", tags=["Share"], route_class=ThrottledRoute)
shoe_id_param = uuid_param("shoeId")
photo_id_param = uuid_param("photoId")

PUBLIC_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
}
HTML_CSP = (
    "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; "
    "base-uri 'none'; form-action 'none'"
)


def api_base_of(request: Request, marker: str) -> str:
    """`${proto}://${host}${prefix-before-marker}` (src/shoes/shoes.controller.ts)."""
    url = request_path(request)
    idx = url.find(marker)
    prefix = url[:idx] if idx >= 0 else ""
    # request.url.scheme already reflects X-Forwarded-Proto from a trusted proxy
    # (TRUSTED_PROXY_IPS); anything else must be a real scheme
    proto = request.url.scheme if request.url.scheme in ("http", "https") else "http"
    host = request.headers.get("host") or "localhost"
    return f"{proto}://{host}{prefix}"


def _share_base(request: Request, marker: str = "/shoes") -> str:
    return request.app.state.shoes.share_base(api_base_of(request, marker))  # type: ignore[no-any-return]


def _svc(request: Request) -> Any:
    return request.app.state.shoes


async def _json(request: Request, schema: Any) -> dict[str, Any]:
    data = await read_json_body(request)
    messages = validate_dict(data, schema.fields)
    if messages:
        raise ValidationFailed(messages)
    return apply_transforms(data, schema.fields)


@router.get("", summary="E31 — list my shoes")
@throttle(60, 60000)
async def list_shoes(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    raw: dict[str, Any] = {}
    for key in request.query_params:
        values = request.query_params.getlist(key)
        raw[key] = values if len(values) > 1 else values[0]
    messages = validate_dict(raw, LIST_SHOES_QUERY.fields)
    if messages:
        raise ValidationFailed(messages)
    q = apply_transforms(raw, LIST_SHOES_QUERY.fields)
    return await request.app.state.shoes_list.list(session, user_uuid(user["sub"]), q)  # type: ignore[no-any-return]


@router.get("/summary", summary="E32 — pairs and potential resale value")
@throttle(60, 60000)
async def summary(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await request.app.state.shoes_list.summary(session, user_uuid(user["sub"]))  # type: ignore[no-any-return]


@router.get("/{shoeId}", summary="E21 — full Shoe Profile")
@throttle(60, 60000)
async def profile(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await _svc(request).get_profile(
        session, user_uuid(user["sub"]), shoe_id, _share_base(request)
    )  # type: ignore[no-any-return]


@router.patch("/{shoeId}", summary="E22 — edit shoe details")
@throttle(60, 60000)
async def update_shoe(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    body = await _json(request, UPDATE_SHOE)
    return await _svc(request).update(  # type: ignore[no-any-return]
        session, user_uuid(user["sub"]), shoe_id, body, _share_base(request)
    )


@router.delete("/{shoeId}", status_code=204, summary="E23 — remove shoe (soft delete)")
@throttle(60, 60000)
async def remove(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> Response:
    await _svc(request).remove(session, user_uuid(user["sub"]), shoe_id)
    return Response(status_code=204)


@router.post(
    "/{shoeId}/share", summary="E24 — create (or return) the public share link"
)
@throttle(30, 60000)
async def share(
    request: Request,
    response: Response,
    user: JwtPayload = Depends(get_current_user),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    created, link = await _svc(request).create_share(
        session, user_uuid(user["sub"]), shoe_id, _share_base(request)
    )
    response.status_code = 201 if created else 200
    return link  # type: ignore[no-any-return]


@router.delete(
    "/{shoeId}/share", status_code=204, summary="E25 — revoke the share link"
)
@throttle(60, 60000)
async def revoke_share(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> Response:
    await _svc(request).revoke_share(session, user_uuid(user["sub"]), shoe_id)
    return Response(status_code=204)


@router.post("/{shoeId}/photos", status_code=201, summary="E27 — add a photo")
@throttle(30, 60000)
async def upload_photo(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    settings = request.app.state.settings
    mp = await read_multipart(
        request,
        file_size=settings.SCAN_PHOTO_MAX_BYTES,
        max_files=1,
        only_file_field="file",
    )
    shoe_id = shoe_id_param(request)
    data = mp.files[0].data if mp.files else None
    return await _svc(request).upload_photo(  # type: ignore[no-any-return]
        session, user_uuid(user["sub"]), shoe_id, data, _share_base(request)
    )


@router.delete("/{shoeId}/photos/{photoId}", summary="E28 — remove a photo")
@throttle(60, 60000)
async def delete_photo(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    photo_id: uuid.UUID = Depends(photo_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await _svc(request).delete_photo(  # type: ignore[no-any-return]
        session, user_uuid(user["sub"]), shoe_id, photo_id, _share_base(request)
    )


@router.post(
    "/{shoeId}/rescan", summary="E29 — rescan: new draft scan linked to this entry"
)
@throttle(30, 60000)
async def rescan(
    request: Request,
    response: Response,
    user: JwtPayload = Depends(get_current_user),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    view = await _svc(request).rescan(session, user_uuid(user["sub"]), shoe_id)
    response.status_code = 201 if view["created"] else 200
    return view  # type: ignore[no-any-return]


@router.post(
    "/{shoeId}/condition-feedback",
    status_code=201,
    summary="E30 — suggest a different condition",
)
@throttle(30, 60000)
async def condition_feedback(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    body = await _json(request, CONDITION_FEEDBACK)
    return await _svc(request).suggest_condition(  # type: ignore[no-any-return]
        session,
        user_uuid(user["sub"]),
        shoe_id,
        body["suggestedConditionCode"],
        body["reason"],
    )


# ─── E26 public share page (no auth) ─────────────────────────────────────────
def wants_html(accept: str | None) -> bool:
    """Express `req.accepts(['html','json']) !== 'json'`: JSON only when the
    client prefers it; anything else (including `*/*`) gets HTML."""
    if not accept:
        return True
    best: tuple[float, int, str] | None = None
    for part in accept.split(","):
        media, _, params = part.strip().partition(";")
        media = media.strip().lower()
        q = 1.0
        for p in params.split(";"):
            k, _, v = p.strip().partition("=")
            if k == "q":
                try:
                    q = float(v)
                except ValueError:
                    q = 0.0
        if q <= 0:
            continue
        kind = None
        if media in ("text/html", "text/*"):
            kind = "html"
        elif media in ("application/json", "application/*"):
            kind = "json"
        elif media == "*/*":
            kind = "html"
        if kind is None:
            continue
        specificity = (
            2 if "/" in media and "*" not in media else 1 if media != "*/*" else 0
        )
        cand = (q, specificity, kind)
        if best is None or (cand[0], cand[1]) > (best[0], best[1]):
            best = cand
    return best is None or best[2] != "json"


@public.get(
    "/{token}",
    summary="E26 — public shoe profile by share token",
    include_in_schema=True,
)
@throttle(60, 60000)
async def public_view(
    token: str, request: Request, session: AsyncSession = Depends(get_session)
) -> Response:
    view = await _svc(request).public_view(session, token)
    html = wants_html(request.headers.get("accept"))
    headers = dict(PUBLIC_HEADERS)
    if view is None:
        if html:
            headers["Content-Security-Policy"] = HTML_CSP
            return HTMLResponse(NOT_FOUND_HTML, status_code=404, headers=headers)
        return JSONResponse(
            {
                "statusCode": 404,
                "code": "SHARE_NOT_FOUND",
                "message": "This shoe profile is no longer shared",
                "timestamp": now_iso(),
                "path": request_path(request),
            },
            status_code=404,
            headers=headers,
            media_type="application/json; charset=utf-8",
        )
    if html:
        headers["Content-Security-Policy"] = HTML_CSP
        page_url = share_url(_share_base(request, "/s/"), token)
        return HTMLResponse(render_share_html(view, page_url), headers=headers)
    return JSONResponse(
        {"statusCode": 200, "message": "Success", "data": view, "timestamp": now_iso()},
        headers=headers,
        media_type="application/json; charset=utf-8",
    )
