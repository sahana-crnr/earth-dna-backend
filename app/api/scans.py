"""`/scans` F1 routes E1 to E9 and E20 (src/scan/scan.controller.ts)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.multipart import read_multipart
from app.api.params import shoe_view_param, user_uuid, uuid_param
from app.core.db import get_session
from app.core.ratelimit import ThrottledRoute, throttle
from app.core.security import JwtPayload, get_current_user
from app.core.validation import query_of, validate_into
from app.schemas.scan import (
    ALBUM_BATCH_BODY,
    LIST_SCANS_QUERY,
    UPLOAD_PHOTO_BODY,
    AlbumBatchBody,
    ListScansQuery,
    UploadPhotoBody,
    parse_manifest,
    parse_taken_at,
)
from app.services.scan import ScanService

router = APIRouter(prefix="/scans", tags=["Scans"], route_class=ThrottledRoute)

scan_id_param = uuid_param("scanId")
shoe_id_param = uuid_param("shoeId")


def scan_service(request: Request) -> ScanService:
    return request.app.state.scans  # type: ignore[no-any-return]


@router.post("", status_code=201, summary="E1 — start a draft scan session")
async def create(
    user: JwtPayload = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> dict[str, Any]:
    return await svc.create_draft(session, user_uuid(user["sub"]))


@router.get("", summary="E2 — list my scans (newest first); ?status=draft to resume")
async def list_scans(
    q: ListScansQuery = Depends(query_of(LIST_SCANS_QUERY, ListScansQuery)),
    user: JwtPayload = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> dict[str, Any]:
    return await svc.list_scans(
        session,
        user_uuid(user["sub"]),
        q.status,
        q.limit if q.limit is not None else 20,
        q.offset or 0,
    )


@router.get("/{scanId}", summary="E3 — session detail")
async def get_scan(
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> dict[str, Any]:
    return await svc.get(session, user_uuid(user["sub"]), scan_id)


@router.post("/{scanId}/shoes", status_code=201, summary="E4 — add a shoe")
async def add_shoe(
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> dict[str, Any]:
    return await svc.add_shoe(session, user_uuid(user["sub"]), scan_id)


@router.delete("/{scanId}/shoes/{shoeId}", summary="E5 — remove a shoe")
async def delete_shoe(
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> dict[str, Any]:
    return await svc.delete_shoe(session, user_uuid(user["sub"]), scan_id, shoe_id)


@router.delete(
    "/{scanId}", status_code=204, summary="E20 — delete an empty draft session"
)
async def delete_scan(
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> Response:
    await svc.delete_empty_draft(session, user_uuid(user["sub"]), scan_id)
    return Response(status_code=204)


@router.put(
    "/{scanId}/shoes/{shoeId}/photos/{view}", summary="E6 — upload or retake one view"
)
@throttle(60, 60000)
async def upload_photo(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> dict[str, Any]:
    settings = request.app.state.settings
    # multer first (file field name, size), then the pipes, then the body
    mp = await read_multipart(
        request,
        file_size=settings.SCAN_PHOTO_MAX_BYTES,
        max_files=1,
        only_file_field="file",
    )
    scan_id = scan_id_param(request)
    shoe_id = shoe_id_param(request)
    view = shoe_view_param(request)
    body = validate_into(mp.fields, UPLOAD_PHOTO_BODY, UploadPhotoBody)
    data = mp.files[0].data if mp.files else None
    return await svc.upload_photo(
        session,
        user_uuid(user["sub"]),
        scan_id,
        shoe_id,
        view,
        data,
        parse_taken_at(body.takenAt),
    )


@router.delete("/{scanId}/shoes/{shoeId}/photos/{view}", summary="E7 — delete one view")
async def delete_photo(
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    shoe_id: uuid.UUID = Depends(shoe_id_param),
    view: str = Depends(shoe_view_param),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> dict[str, Any]:
    return await svc.delete_photo(
        session, user_uuid(user["sub"]), scan_id, shoe_id, view
    )


@router.post("/{scanId}/photos/batch", status_code=200, summary="E8 — album upload")
@throttle(10, 60000)
async def album_batch(
    request: Request,
    user: JwtPayload = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> dict[str, Any]:
    settings = request.app.state.settings
    mp = await read_multipart(
        request,
        file_size=settings.SCAN_PHOTO_MAX_BYTES,
        max_files=settings.SCAN_ALBUM_MAX_PHOTOS,
    )
    scan_id = scan_id_param(request)
    body = validate_into(mp.fields, ALBUM_BATCH_BODY, AlbumBatchBody)
    manifest = parse_manifest(body.manifest)
    return await svc.album_batch(
        session, user_uuid(user["sub"]), scan_id, manifest, mp.files
    )


@router.post("/{scanId}/finish", status_code=200, summary="E9 — finish scanning")
async def finish(
    user: JwtPayload = Depends(get_current_user),
    scan_id: uuid.UUID = Depends(scan_id_param),
    session: AsyncSession = Depends(get_session),
    svc: ScanService = Depends(scan_service),
) -> dict[str, Any]:
    return await svc.finish(session, user_uuid(user["sub"]), scan_id)
