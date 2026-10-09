# F2 — Identification Results

## What it is
The backend side of "Scan processing" and "Review Matches". Identification runs on the device (ShoeDNA on-device model); once the app has a result for a shoe it submits it to the backend, which stores it against the scan shoe and tells the app, per shoe, whether a result is still awaited. When every shoe of a session has a result the session moves from `processing` to `review`, which is where F3 picks up.

## Screens it serves
| Screen | What the backend provides |
|---|---|
| Scan processing (Waiting… / Identified) | E11 polled every ~2 s until `allResolved` |
| Review Matches (brand, match %, condition label) | the stored result per shoe, `matchPercent` and the condition label derived on read |

## Rules in one place
- Login required; a user only sees their own scans (foreign ids answer 404).
- A result is accepted only after `POST /scans/{id}/finish` (session `processing` or `review`). A draft answers 409 `NOT_PROCESSING`.
- One result per shoe. Re-submitting replaces it in place (200, `replaced: true`); the first submit answers 201.
- Once F3 has confirmed or rejected a shoe its result is locked: 409 `RESULT_LOCKED`.
- `source` is always `device` and `submittedAt` is the server clock; neither can be set by the client.
- An `identified` result needs `brand` and `confidence`; `failed` needs neither. Up to `SCAN_RESULT_MAX_CANDIDATES` ranked candidates (default 3), no duplicate brand+model, confidences in 0..1 (rounded to 4 decimals). The free-form `raw` blob is capped at `SCAN_RESULT_RAW_MAX_BYTES` (default 8192) and 6 levels deep.
- Condition codes are ShoeDNA's `C1`–`C5`; the label shown (Like New / Lightly Worn / Heavily Worn / Not wearable) is derived on read and is still provisional.
- Since F3: optional `category`, `subCategory`, `material` on the submit body, stored and echoed back; they are what the review step copies into My Shoes.

## Endpoints
Base path `/api/v1`, `Authorization: Bearer <accessToken>`, success envelope `{ statusCode, message, data, timestamp }`.

| # | Method + path | Body | Success | Errors |
|---|---|---|---|---|
| E10 | `POST /scans/{scanId}/shoes/{shoeId}/result` | `modelVersion` (required), `outcome` (identified default / failed), `brand`, `subBrand`, `model`, `colorway`, `category`, `subCategory`, `material`, `confidence` 0..1, `conditionCode` C1–C5, `candidates[]`, `raw{}` | 201 first time, 200 on replace: `{ shoeId, label, replaced, status, result, scanStatus }` | 400 `RESULT_INCOMPLETE` / `TOO_MANY_CANDIDATES` / `DUPLICATE_CANDIDATE` / `CONFIDENCE_OUT_OF_RANGE` / `RAW_TOO_DEEP` · 404 · 409 `NOT_PROCESSING` / `RESULT_LOCKED` · 413 `RAW_TOO_LARGE` |
| E11 | `GET /scans/{scanId}/results[?include=raw]` | — | 200 results view (below) | 404 |

### Results view
```json
{ "scanId": "uuid", "status": "review", "allResolved": true,
  "reviewed": { "done": 0, "total": 2 },
  "shoes": [
    { "shoeId": "uuid", "position": 1, "label": "Shoe 01", "status": "identified",
      "result": { "source": "device", "outcome": "identified", "modelVersion": "shoedna-tflite-1.4.2",
                  "brand": "Nike", "subBrand": null, "model": null, "colorway": null,
                  "category": "athletic_shoes", "subCategory": "running_shoes", "material": null,
                  "confidence": 0.9234, "matchPercent": 92,
                  "condition": { "code": "C2", "label": "Lightly Worn" },
                  "candidates": [ { "brand": "Nike", "model": "Air Max 90", "confidence": 0.9234 } ],
                  "submittedAt": "…", "updatedAt": "…" },
      "review": null, "myShoeId": null, "myShoe": null,
      "suggested": { "brandId": "uuid", "brand": "Nike" } } ] }
```
`status` per shoe is `waiting` (no result yet), `identified` or `failed`. `raw` is included only with `?include=raw` (always on the E10 response). `reviewed`, `review`, `myShoeId`, `myShoe` and `suggested` belong to F3 and are null / zero until a review happens.

## Settings
| Key | Default | Meaning |
|---|---|---|
| `SCAN_RESULT_MAX_CANDIDATES` | 3 | ranked candidates kept per result |
| `SCAN_RESULT_RAW_MAX_BYTES` | 8192 | cap on the `raw` passthrough blob |

## Behaviour details
- Every submit runs in one transaction under a row lock on the scan, so two shoes finishing at the same moment cannot both miss the "last shoe flips the scan to review" step, and a retried submit serialises into an idempotent replace.
- The app renders `matchPercent` and `condition.label` as given; it never computes them, so two clients can never disagree about the same stored result.
