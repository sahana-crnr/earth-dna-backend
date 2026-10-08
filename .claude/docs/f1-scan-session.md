# F1 — Scan Session and Photo Upload

## What it is
The backend behind the S.H.O.E.S. capture flow (Figma sections 0, 1, 2). A user opens a scan session, adds up to 4 shoes, and captures 4 views of each shoe: top, right, left and sole. Every photo is saved to the backend the moment it is taken, so the user can leave and resume later. "Finish scanning" hands the session to identification (F2).

## Why it comes first
Every later screen (processing, review matches, My Shoes, shoe profile) needs a stored scan. F1 is storage and session rules only, with no ML dependency, so it unblocks the most screens.

## Screens it serves
| Screen | What the backend provides |
|---|---|
| Capture top / right / left / bottom, Retake | Photo upload per view; retake overwrites |
| confirm modal ("Shoe 01 is complete") | Per-shoe completeness |
| Scan another shoe | Add the next shoe (Shoe 02…), max 4 |
| Exit Scan Confirmation ("finish anytime") | Draft sessions persist and can be listed and resumed |
| Scanned Collections, Review scans | Session detail: shoes, captured views, missing views, photo thumbnails |
| Shoe options menu | Delete a photo or a whole shoe; labels renumber |
| Upload from Album, Review uploaded photos | Batch upload: up to 3 pairs / 12 photos, partial success |
| Finish scanning | Allowed only when every shoe has all 4 views |

## Rules in one place
- Login required on every endpoint. A user only ever sees their own sessions.
- Camera sessions: up to 4 shoes. Album batch: up to 3 shoes and 12 photos.
- Photos: JPG / JPEG / PNG, max 1 MB each. Both limits are settings.
- A shoe is complete when it has all 4 views. Finish is blocked by any shoe that is partial or empty.
- Removing a shoe renumbers the rest (Shoe 03 becomes Shoe 02).
- Retaking a view replaces the old photo.
- Deleting a photo or shoe removes the stored file immediately (switchable setting, on).
- Drafts are unlimited per user for now (switchable setting). A draft untouched for 30 days becomes abandoned.

## Status flow
```text
draft --finish--> processing --(F2 results ready)--> review --(all shoes confirmed/rejected, F3)--> completed
draft --30 days idle--> abandoned
```
F1 owns `draft`, `processing` and `abandoned`. `review` and `completed` are set by F2 and F3.

## Delivery
Build, test locally, raise a PR, deploy to dev, test on dev with a browser test page, then hand that page to the app team for integration. Endpoint details are in Swagger at `/docs` on each environment.


---

# F1 — How It Works (functional design)

**Decisions**: the decision log (F1-D1..D15) · **Schema**: the data model (scans, scan_shoes, scan_photos)
**Base path**: `/api/v1` · **Auth**: `Authorization: Bearer <accessToken>` on every route · **Envelope**: every success is wrapped by the existing interceptor as `{ statusCode, message, data, timestamp }`; `data` is shown below.

---

## 1. Data (from the data model, F1 slice)

| Table | F1 columns used | Notes |
|---|---|---|
| `scans` | id, userId, status, source, finishedAt, createdAt, updatedAt | `source` = camera or album (set by the first upload path used; informational) |
| `scan_shoes` | id, scanId, position, status, createdAt, updatedAt | `rescanOfShoeId` column created now, FK added in F4/F5 when `shoes` exists. `label` and completeness are computed, not stored (F1-D6) |
| `scan_photos` | id, scanShoeId, view, s3Key, contentType, bytes, width?, height?, uploadStatus, takenAt, createdAt | unique (scanShoeId, view). `uploadStatus` always `uploaded` (F1-D1) |

`scan_shoes.status` in F1: `capturing` (fewer than 4 views) and `complete` (4 views). It is recomputed after every photo add or delete. F2 moves it on.

## 2. Storage

- One interface `PhotoStorage` with `put(key, bytes, contentType)`, `delete(key)`, `signedGetUrl(key, ttlSeconds)`.
- One implementation on the AWS SDK v3 S3 client. Locally it points at LocalStack through `STORAGE_S3_ENDPOINT` + path-style; on dev it talks to real S3.
- Key: `scans/{scanId}/{scanShoeId}/{view}-{uid}.{jpg|png}` — every upload gets a unique key. A retake writes a new object, the row is switched to it in the transaction, and the previous object is deleted after commit. A rejected or racing request can never replace a live photo.
- Thumbnails for Review scans: the session response carries a short-lived signed GET URL per photo (`SCAN_PHOTO_URL_TTL_SECONDS`, default 900). The bucket stays private.

## 3. Settings (all env, all with defaults)

| Key | Default | Meaning |
|---|---|---|
| `SHOE_PHOTOS_BUCKET` | required | bucket name; app refuses to start F1 routes without it |
| `STORAGE_S3_ENDPOINT` | unset | LocalStack URL locally, unset on dev |
| `STORAGE_S3_FORCE_PATH_STYLE` | false | true for LocalStack |
| `STORAGE_S3_PUBLIC_ENDPOINT` | unset | only when the backend runs in Docker locally: browser-reachable LocalStack host for signed URLs |
| `CORS_ORIGINS` | unset | comma list of browser origins; unset = any (previous behaviour) |
| `SCAN_MAX_SHOES` | 4 | per session |
| `SCAN_ALBUM_MAX_SHOES` | 3 | per batch |
| `SCAN_ALBUM_MAX_PHOTOS` | 12 | per batch |
| `SCAN_PHOTO_MAX_BYTES` | 1048576 | 1 MB |
| `SCAN_PHOTO_ALLOWED_TYPES` | jpeg,png | checked from the file's first bytes, not its name or declared type |
| `SCAN_MAX_OPEN_DRAFTS` | 0 | 0 = unlimited |
| `SCAN_DELETE_OBJECTS_ON_REMOVE` | true | delete the S3 object when a photo/shoe is removed |
| `SCAN_DRAFT_ABANDON_DAYS` | 30 | idle drafts become abandoned |
| `SCAN_PHOTO_URL_TTL_SECONDS` | 900 | signed thumbnail URL lifetime |

## 4. Endpoints

### Session object (returned by most calls)
```json
{
  "id": "uuid", "status": "draft", "source": "camera",
  "createdAt": "…", "updatedAt": "…", "finishedAt": null,
  "canFinish": false,
  "shoes": [
    { "id": "uuid", "position": 1, "label": "Shoe 01", "status": "complete",
      "complete": true, "missing": [],
      "photos": [ { "view": "top", "contentType": "image/jpeg", "bytes": 482113, "takenAt": "…", "url": "https://…signed…" } ] },
    { "id": "uuid", "position": 2, "label": "Shoe 02", "status": "capturing",
      "complete": false, "missing": ["left","sole"], "photos": [ … ] }
  ]
}
```
`canFinish` = at least one shoe and every shoe complete.

| # | Method + path | Body | Success | Errors |
|---|---|---|---|---|
| E1 | `POST /scans` | `{}` | 201 session (empty `shoes`) | 409 `DRAFT_LIMIT_REACHED` only when `SCAN_MAX_OPEN_DRAFTS` > 0 |
| E2 | `GET /scans?status=draft` | — | 200 `{ items: [session summary], total }`, newest first; `status` optional (any F1 status) | 400 bad status value |
| E3 | `GET /scans/{scanId}` | — | 200 session | 404 not found / not yours |
| E4 | `POST /scans/{scanId}/shoes` | `{}` | 201 session (new shoe appended) | 404 · 409 `NOT_DRAFT` · 409 `SHOE_LIMIT_REACHED` |
| E5 | `DELETE /scans/{scanId}/shoes/{shoeId}` | — | 200 session (renumbered) | 404 · 409 `NOT_DRAFT` |
| E6 | `PUT /scans/{scanId}/shoes/{shoeId}/photos/{view}` | multipart: `file` (required), `takenAt` (ISO, optional) | 200 session | 400 `INVALID_VIEW` · 400 `FILE_REQUIRED` · 400 `UNEXPECTED_FILE_FIELD` (part not named `file`) · 413 `FILE_TOO_LARGE` · 415 `UNSUPPORTED_TYPE` · 404 · 409 `NOT_DRAFT` · 502 `STORAGE_UNAVAILABLE` |
| E7 | `DELETE /scans/{scanId}/shoes/{shoeId}/photos/{view}` | — | 200 session | 400 `INVALID_VIEW` · 404 (incl. view not captured) · 409 `NOT_DRAFT` |
| E8 | `POST /scans/{scanId}/photos/batch` | multipart: `manifest` (JSON) + files, see below | 200 batch result | 400 `INVALID_MANIFEST` · 400 `DUPLICATE_FILE_FIELD` · 404 · 409 `NOT_DRAFT` · 413 batch over limits |
| E9 | `POST /scans/{scanId}/finish` | `{}` | 200 session (`status: processing`) | 404 · 409 `NOT_DRAFT` (already finished) · 409 `SCAN_INCOMPLETE` with `{ incomplete: [{ shoeId, label, missing }] }` · 409 `NO_SHOES` |
| E20 | `DELETE /scans/{scanId}` | — | 204 (empty body) | 404 · 409 `NOT_DRAFT` (session was processed; never deleted) · 409 `SCAN_NOT_EMPTY` with `{ shoeCount }` (remove shoes with E5 first). Added 2026-10-07 for the app's "discard empty scan" case |

E6 uses `PUT` because it is idempotent: the same call twice leaves one photo (retake = upload again, F1-D10). Asana's task text says `POST`; `PUT` is the only change.

Error body: `{ statusCode, timestamp, path, message, code, details? }` — `code` is the stable value to branch on.

Not-yours and not-found both return 404 so a caller cannot probe other users' IDs.

### E8 album batch
Manifest (Figma: up to 3 pairs, 12 photos):
```json
{ "shoes": [
    { "ref": "a", "files": [ { "field": "f1", "view": "top" }, { "field": "f2", "view": "right" },
                             { "field": "f3", "view": "left" }, { "field": "f4", "view": "sole" } ] },
    { "ref": "b", "files": [ { "field": "f5", "view": "top" }, { "field": "f6", "view": "right" } ] } ] }
```
Each `field` names a multipart file part. `ref` is the app's own label for matching the response.

Rules: files are written to S3 first (no DB connection held), then one short transaction inserts the rows; capacity is re-checked under the lock. One file larger than `SCAN_PHOTO_MAX_BYTES` aborts the **whole** upload with 413 `FILE_TOO_LARGE` (the upload parser stops reading to protect memory); every other problem is judged per shoe. New shoes are appended to the session (session total still capped at `SCAN_MAX_SHOES`); a shoe entry with a duplicate view, an unknown field, a bad file type or size is rejected **as a shoe**, the others are saved (partial, F1-D13).

Response:
```json
{ "session": { …session… },
  "results": [ { "ref": "a", "saved": true,  "shoeId": "uuid", "label": "Shoe 01", "complete": true,  "missing": [] },
               { "ref": "b", "saved": true,  "shoeId": "uuid", "label": "Shoe 02", "complete": false, "missing": ["left","sole"] },
               { "ref": "c", "saved": false, "error": "DUPLICATE_VIEW", "detail": "view 'top' appears twice" } ] }
```
The "Add 2 more photos to continue" state comes straight from `missing`.

## 5. Behaviour details

- **Ownership**: every query filters by `userId` from the JWT; IDs from another user behave as not found.
- **Draft-only edits**: E4–E8 and E20 need `status = draft`; otherwise 409 `NOT_DRAFT`. E20 additionally needs zero shoes, so photos are never dropped by a session delete.
- **Upload order**: validate (size, type from bytes, view) → write S3 under a new unique key → short transaction: upsert row, recompute shoe status, build the response from the same transaction → after commit delete the replaced object. If the transaction fails, the new object is deleted and the error returned.
- **Delete order**: remove row(s) in a transaction → then delete S3 object(s) if `SCAN_DELETE_OBJECTS_ON_REMOVE`. An S3 delete failure is logged, not returned (the row is already gone; the abandoned-scan lifecycle rule is the backstop).
- **Renumber**: after E5, positions are rewritten 1..n in their previous order inside the same transaction.
- **Finish**: checks `canFinish`; flips `scans.status` to `processing`, sets `finishedAt`, sets each shoe to `complete`. A second call returns 409 `NOT_DRAFT`, so a double tap cannot double-submit.
- **Abandon job**: daily, marks drafts with `updatedAt` older than `SCAN_DRAFT_ABANDON_DAYS` as `abandoned` and deletes their photo rows and S3 objects. Idempotent. `ScanService.deleteAllForUser(userId)` exists for a future account-deletion flow (must run before the users row is deleted).
- **Every write bumps `scans.updatedAt`**, which drives resume ordering and abandonment.

## 6. Testable properties (PBT-01)

| ID | Component | Property | Category |
|---|---|---|---|
| P1 | `computeShoeState(views)` | complete ⇔ the set of distinct views = {top,right,left,sole}; `missing` = that set minus captured, in canonical order | Invariant / oracle |
| P2 | `labelFor(position)` | `Shoe NN` round-trips back to its position for 1..99 | Round-trip |
| P3 | `renumber(positions)` | output is exactly 1..n, preserves relative order, length unchanged | Invariant |
| P4 | `canFinish(shoes)` | true ⇔ shoes non-empty and every shoe complete | Oracle |
| P5 | `validateAlbumManifest` | every input shoe appears once in output; saved ⇔ no rule violated; saved count ≤ remaining capacity | Invariant / oracle |
| P6 | `sniffImageType(bytes)` | JPEG/PNG magic bytes accepted, any other prefix rejected; result independent of file name | Oracle |
| P7 | Session state machine | random command sequences (add shoe, upload view, delete view, delete shoe, finish) against a simple in-memory model: after every step shoe count ≤ max, positions contiguous, `canFinish` matches the model, no edits after finish | Stateful (PBT-06) |
| P8 | Upload idempotence | uploading the same view twice leaves exactly one photo for that view | Idempotence |

Pure functions (P1–P6) live in one `scan-rules.ts` file with no Nest or DB imports so they can be property-tested directly.

## 7. Security mapping (enabled baseline)

| Rule | How F1 meets it |
|---|---|
| SECURITY-05 input | DTOs with class-validator; view is an enum; UUID params validated; manifest schema-validated with array caps; multipart limits (file size, file count, field size) set on the parser |
| SECURITY-08 access | `JwtAuthGuard` on the controller; ownership filter in every query (404 on foreign IDs). CORS: pre-existing open config noted in the plan |
| SECURITY-03 logging | Log scan/shoe IDs and outcome; never tokens or image bytes |
| SECURITY-15 errors | S3 and DB calls wrapped; generic client messages with stable error codes; transactions roll back on failure |
| SECURITY-09 / 12 | No bucket names or credentials in code; bucket private; signed URLs short-lived |
| SECURITY-11 throttling | Per-route limits on upload and batch routes |
