# F5 — Shoe Profile and Manage

## What it is
The backend behind one My Shoes entry (Figma section 4: Shoe Profile, Edit shoe details, Share shoe profile, Condition feedback, Remove this shoe, Rescan). F3 created the entry; F5 lets the user look at it in full, change what ShoeDNA could not know, share it with a public link, challenge the condition grade, rescan the pair, or remove it. Everything the profile shows comes from one call. Value and recommendation are still the F3 placeholders behind a provider interface, so the ValueLens service can replace them without touching the endpoints. Carbon footprint / CO2e is out of scope and no longer returned anywhere.

## Screens it serves
| Screen | What the backend provides |
|---|---|
| Shoe Profile | `GET /shoes/{id}`: identity, photos (signed, 1 h), condition grade + label + copy, resale range + demand note, recommendation + reason, material profile, CircularSort placeholder, share state, origin scan, open rescan |
| Manage this Shoe (sheet) | Edit → E22 / E27 / E28; Share → E24 / E25; Rescan → E29; Remove → E23 |
| Edit shoe details | Photos grid (4/8, Main, add, remove): E27 upload, E28 delete, `primaryPhotoId` on E22. Fields Brand, Model, Shoe Type, Color, Size: E22 with ids from E14 brands, E15 sizes, E16 shoe types |
| Condition feedback | E30: suggested condition + reason stored as training feedback; the assessment does not change |
| About your resale value (sheet) | static text; `value.source = "static"` tells the app the numbers are placeholders |
| Share shoe profile | E24 returns `{ url, token }`; E26 serves the public page (JSON, or HTML with OpenGraph when the client prefers text/html) |
| Remove this shoe? | E23 soft delete; the share link stops working; photos and scan rows are kept server-side |
| Choose pathway / donation / marketplace | Not F5. Those flows will write `actionTaken`; E22 accepts the field meanwhile |

## 1. Data
| Table | Columns | Notes |
|---|---|---|
| `shoe_photos` | id, shoeId, source `scan` / `upload`, scanPhotoId, view (scan rows), s3Key, contentType, sizeBytes, sortOrder, createdAt | One row per photo of an entry. Review copies the captured views in (keys only, same S3 objects); E27 adds uploads under `shoes/{userId}/{shoeId}/` |
| `shoes` | + shoeTypeId, shoeType, primaryPhotoId (FK `shoe_photos`); − primaryPhotoS3Key, − co2eKg | Existing entries were backfilled by the migration |
| `shoe_shares` | id, shoeId, token (unique), expiresAt (unused), revokedAt, viewCount, createdAt | One active link per shoe |
| `catalog_shoe_types` | id, slug, name, sortOrder, isActive | Six fixed rows: Athletic Shoes, Casual Shoes, Dress Shoes, Boots, Sandals, Slippers |
| `catalog_categories` | + shoeTypeId | Filled by `npm run catalog:seed` from keyword rules |
| `scans` | + hiddenAt | Set when the last entry of a session is removed; hidden from `GET /scans` lists |
| `shoe_feedback.type` | + `condition_suggested`, `rescanned` | Append-only |
| `condition_mappings` | four grades: C1 A+ Like New · C2 A Lightly Worn · C3 / C4 B Heavily Worn · C5 C Not wearable | Labels are data (T18) |

## 2. Settings (env, all with defaults)
| Key | Default | Meaning |
|---|---|---|
| `SHOE_MAX_PHOTOS` | 8 | photos per shoe, scan views included |
| `SHOE_PHOTO_URL_TTL_SECONDS` | 3600 | signed URL TTL on E21 / E26 |
| `SHARE_BASE_URL` | unset → request API base | prefix of share links (`…/s/{token}`), e.g. `https://earthdna.app` |
| `SHARE_TOKEN_RANDOM_CHARS` | 6 | random part of a share token |
| `SHOE_UPLOAD_PREFIX` | `shoes` | S3 key prefix for uploads |
| `SCAN_PHOTO_MAX_BYTES`, `SCAN_PHOTO_ALLOWED_TYPES` | F1 values | reused for E27 |
| `CATALOG_MUTED_ENDPOINTS` | empty | `categories` is un-muted since F5 (it is the shoe type list) |

## 3. Endpoints
All under `/api/v1`, JWT required except E26. Owner check on every `shoeId` (404 when not found, not yours, or removed; never 403).

| # | Endpoint | Body / query | Success | Errors |
|---|---|---|---|---|
| E21 | `GET /shoes/{shoeId}` | — | 200 profile view | 404 |
| E22 | `PATCH /shoes/{shoeId}` | brandId, model, color, sizeId, shoeTypeId, gender, actionTaken, primaryPhotoId — all optional, at least one; `null` clears model / color / size / shoe type / gender | 200 profile view | 400 validation / `EMPTY_UPDATE` / `UNKNOWN_BRAND` / `UNKNOWN_SIZE` / `UNKNOWN_SHOE_TYPE` / `UNKNOWN_PHOTO` · 404 |
| E23 | `DELETE /shoes/{shoeId}` | — | 204 | 404 |
| E24 | `POST /shoes/{shoeId}/share` | — | 201 `{ url, token, createdAt }` (200 when a link exists) | 404 |
| E25 | `DELETE /shoes/{shoeId}/share` | — | 204 (also when none) | 404 |
| E26 | `GET /s/{token}` (public) | `Accept: text/html` → HTML page, else JSON (standard `{ statusCode, message, data }` envelope) | 200 public view | 404 `SHARE_NOT_FOUND` (unknown, revoked, shoe removed) |
| E27 | `POST /shoes/{shoeId}/photos` | multipart `file` | 201 profile view | 400 `FILE_REQUIRED` / `UNEXPECTED_FILE_FIELD` · 413 `FILE_TOO_LARGE` · 415 `UNSUPPORTED_TYPE` · 409 `PHOTO_LIMIT_REACHED` · 404 · 502 `STORAGE_UNAVAILABLE` |
| E28 | `DELETE /shoes/{shoeId}/photos/{photoId}` | — | 200 profile view | 404 `SHOE_NOT_FOUND` / `PHOTO_NOT_FOUND` · 409 `LAST_PHOTO` |
| E29 | `POST /shoes/{shoeId}/rescan` | — | 201 `{ scanId, shoeId, status, created: true }` (200 with `created: false` when a rescan is open) | 404 · 409 `DRAFT_LIMIT_REACHED` · 503 `STORAGE_NOT_CONFIGURED` |
| E30 | `POST /shoes/{shoeId}/condition-feedback` | `{ suggestedConditionCode: C1–C5, reason ≤ 500 }` | 201 `{ suggestedConditionCode, reason, createdAt }` | 400 · 404 |
| E16 | `GET /catalog/categories` | — | 200 `{ items: [{ id, name, slug, categories: [{ id, name, slug }] }] }` — the six shoe types with the product categories mapped under them | — |
| E2 | `GET /scans?status=` | — | hidden sessions are excluded | — |
| E11 | results view `myShoe` | + `shoeType { id, name }`, `primaryPhotoId`; `thumbnailUrl` now comes from the primary photo row; `co2eKg` gone | — |

### Profile view (E21; also the response of E22, E27, E28)
```json
{
  "id": "…", "brand": { "id": "…", "name": "On Running" }, "subBrand": "Cloudmonster",
  "model": "Cloudmonster 2", "shoeType": { "id": "…", "name": "Athletic Shoes" },
  "category": "running", "subCategory": null, "color": "Black",
  "size": { "id": "…", "label": "9" }, "gender": "men",
  "condition": { "code": "C2", "grade": "A", "label": "Lightly Worn", "description": "Minor signs of wear, fully functional", "filterGroup": "Good" },
  "conditionFeedback": null,
  "material": null,
  "value": { "min": 65, "max": 90, "currency": "USD", "demandNote": "High demand silhouette", "source": "static", "version": null, "computedAt": "…" },
  "recommendation": { "action": "resell", "reason": "Due to high demand and exceptional condition, keeping this pair in circulation maximizes value." },
  "materials": [ { "part": "upper", "material": "Mesh / Synthetic Leather", "source": "static" }, { "part": "midsole", "material": "…", "source": "static" }, { "part": "outsole", "material": "…", "source": "static" }, { "part": "laces", "material": "…", "source": "static" } ],
  "circularSort": { "status": "pending" },
  "photos": [ { "id": "…", "source": "scan", "view": "top", "url": "https://…", "isPrimary": false, "sortOrder": 0, "createdAt": "…" }, { "id": "…", "source": "scan", "view": "right", "url": "https://…", "isPrimary": true, "sortOrder": 1, "createdAt": "…" } ],
  "actionTaken": "none", "actionTakenAt": null,
  "share": { "active": false, "url": null, "createdAt": null },
  "scan": { "scanId": "…", "scanShoeId": "…" },
  "rescan": null,
  "createdAt": "…", "updatedAt": "…"
}
```
Photo `view` is `top`, `right`, `left` or `sole` (Figma labels it "Bottom") for scan photos, `null` for uploads. `rescan` is `{ scanId, shoeId, status }` while a rescan session is draft / processing / review.

### Public view (E26, JSON)
```json
{ "brand": "On Running", "model": "Cloudmonster 2", "shoeType": "Athletic Shoes", "color": "Black",
  "condition": { "grade": "A", "label": "Lightly Worn" },
  "value": { "min": 65, "max": 90, "currency": "USD" },
  "recommendedAction": "resell", "photoUrl": "https://…", "sharedAt": "…" }
```
The HTML variant is one static page (inline style, no script) with `og:title`, `og:description`, `og:image`; `Cache-Control: no-store`, `X-Robots-Tag: noindex`, a strict CSP.

## 4. Behaviour
- **Edit (E22)**: in one transaction with the shoe locked: resolve catalog ids → overlay only the fields sent → if brand / model / colour / size changed, re-run the silent product match (`catalogProductId`, `msrp`) → if the brand changed and the value is still the placeholder, recompute it → `actionTaken` change sets `actionTakenAt` (cleared on `none`) → `primaryPhotoId` must be one of the shoe's photos. Edits never write a feedback row. Condition is not editable.
- **Remove (E23)**: `deletedAt` set, the active share revoked, the origin scan hidden from lists once no other entry of that session is left. Nothing is deleted from S3; scan, photo and feedback rows stay.
- **Share (E24 / E25 / E26)**: one active link per shoe; E24 returns it or creates one (`{model-slug}-{6 random chars}`). Links never expire. E26 counts views; 60 requests per minute per IP.
- **Photos (E27 / E28)**: same validation as the F1 upload (bytes sniffed, size cap); key `shoes/{userId}/{shoeId}/{photoId}.{ext}`; the object is written before the row and removed again when the request fails. A shoe keeps at least one photo; removing the main photo promotes the one with the lowest sort order. Deleting an uploaded photo removes its object; deleting a scan photo from the shoe leaves the scan's object alone.
- **Rescan (E29)**: creates a draft scan with one shoe linked to the entry (`rescanOfShoeId`). Continue with the F1 photo endpoints, finish, F2 result, F3 confirm / reject. That review **updates the entry in place**: identity from the new answer, condition from the new result, the four scan photos replaced (uploads kept, moved behind them), value recomputed while static; a `rescanned` feedback row holds the previous entry. Share links keep working. The previous scan session is hidden from `GET /scans` lists (its rows stay). Only one open rescan per shoe: a second E29 answers 200 with the same ids.
- **Condition feedback (E30)**: append-only `shoe_feedback` row; the profile shows the latest suggestion as `conditionFeedback`.
- **Account deletion**: `shoes`, `shoe_photos`, `shoe_shares` cascade from `users`.

## 5. Test page
`local-infra/ui/f5-shoe-profile.html`: load a profile by id (or pick one from the F3 page's `myShoeId`), edit form with catalog dropdowns, photo grid (set main, add, remove), share (create, open the public page, copy, revoke), condition feedback, rescan (hands over to the F1 page), remove.
