# F3 — Match Feedback and Catalog

## What it is
The backend behind the review step of the S.H.O.E.S. flow (Figma section 3: Review Matches, Match Confirmed, Find Your Shoe, Matches confirmed). After F2 has stored a ShoeDNA result for every shoe in a session, the user looks at each shoe and either confirms the prediction ("That's my shoe") or rejects it ("Not my shoe"). In both cases the app shows a details form: the detected fields are prefilled and the user adds what ShoeDNA cannot see. The backend turns that answer into a My Shoes entry, keeps the original prediction plus the user's answer as training feedback, and closes the session once every shoe is reviewed. Six small catalog endpoints feed the form's dropdowns.

## Why it comes third
F1 stores the photos, F2 stores the prediction. F3 is the first step that creates something the user keeps: the My Shoes entry that F4 (list), F5 (profile) and F6 (home stats) all read. Nothing in sections 4 and 0 can show real data before F3.

## Screens it serves
| Screen | What the backend provides |
|---|---|
| Review Matches ("0 of 4 reviewed") | Sessions ready for review; per shoe: prediction, match %, condition label, review state; `reviewed { done, total }` |
| That's my shoe + details form | Confirm with the user's final details; My Shoes entry created |
| Not my shoe → Find Your Shoe form | Reject with brand, model, colour, size; My Shoes entry created from the user's answer |
| Brand / Size / other dropdowns | Catalog lists: brands, sizes per brand, categories, models, colours, genders, conditions |
| Matches confirmed ("All shoes are added to My Shoes") | Session `completed`; My Shoes ids returned |

## Rules in one place
- Login required on every endpoint. A user only ever reviews their own sessions.
- Only a session whose F2 results are all in (status `review`) accepts a review.
- Each shoe is reviewed once. A second confirm or reject answers 409 `ALREADY_REVIEWED`. Later edits happen on the Shoe Profile page (F5).
- Confirm and reject take the same body: brand, model, colour, size, gender. On reject, brand, model, colour and size are required. On confirm everything is optional: the predicted brand, model and colour fill whatever the body leaves out.
- Brand and size must be catalog ids. Model and colour are free text with length limits.
- The user's answer wins over the prediction for brand, model and colour. Category, sub-category, condition and material are never in the body and always come from the prediction (F3-D5, D8). A predicted brand of "Unknown" counts as no brand: the user must pick one.
- Every review writes one feedback row (prediction + answer + time): `confirmed` when the brand stood, `corrected` on reject or when the user changed the brand. Feedback rows are never changed or deleted; on account deletion the database keeps them with the user id cleared.
- My Shoes value, recommendation and CO2e are placeholders until the ValueLens and CircularSort endpoints exist.
- The catalog is seeded by a re-runnable script from the S3 footwear taxonomy and the product export. No vendor name appears in tables, columns or routes.

## Status flow
```text
review --(every shoe confirmed or rejected)--> completed
scan_shoes: identified --confirm--> confirmed
            identified --reject---> rejected
```

## Delivery
Build, test locally, raise a PR, deploy to dev, test on dev with the browser test page `local-infra/ui/f3-match-feedback.html`, hand that page to the app team. Endpoint details in Swagger at `/docs`. Feature guides for F1, F2 and F3 are also copied into `earth-dna-B.E/.claude/docs/` so the team sees them in git.


---

# F3 — How It Works (functional design)

**Decisions**: the decision log (F3-D1..D17) · **Schema**: the data model (F3 + My Shoes slices)
**Base path**: `/api/v1` · **Auth**: `Authorization: Bearer <accessToken>` on every route · **Envelope**: `{ statusCode, message, data, timestamp }`; `data` shown below.

---

## 1. Data

### Review and My Shoes
| Table | Columns | Notes |
|---|---|---|
| `shoes` (My Shoes) | id, userId, scanShoeId (unique), brand, subBrand, category, subCategory, model, colorway, size, gender, conditionCode, material (null), recommendedAction, actionTaken, actionTakenAt, resaleMin, resaleMax, resaleCurrency, resaleBucket, demandNote, recommendationReason, co2eKg, valueSource, valueSourceVersion, valueComputedAt, catalogProductId, msrp, primaryPhotoS3Key, deletedAt, createdAt, updatedAt | Full F4/F5 schema created now (F3-D13b). F3 fills identity + placeholders; F4/F5 fill the rest |
| `shoe_feedback` | id, scanShoeId, resultId, userId (null on account deletion), type `confirmed` / `corrected`, original jsonb, answer jsonb, createdAt | Append-only training signal (F3-D14, D15) |
| `scan_shoe_results` (F2) | + `category`, `subCategory`, `material` (nullable) | F3-D18; E10 DTO gains the same optional fields |
| `scan_shoes.status` | `confirmed` / `rejected` | values exist since F1 |
| `scans.status` | `completed` | set when every shoe is reviewed |

### Catalog
| Table | Columns | Seeded from |
|---|---|---|
| `catalog_categories` | id, slug, name, sortOrder, isActive | taxonomy `category` |
| `catalog_subcategories` | id, categoryId, slug, name, sortOrder, isActive | taxonomy `subcategory` |
| `catalog_brands` | id, slug, name, sortOrder, isActive | taxonomy `brand` |
| `catalog_brand_subcategories` | brandId, subcategoryId | taxonomy rows |
| `catalog_products` | id, brandId, sku, model, modelCode, category, subCategory, silhouette, gender, colour, size (normalised), sizeRaw, msrp, releaseDate, title, source, isActive, importedAt | product DB (`keepa.products`) |
| `catalog_sizes` | id, brandId (null = generic), system `US`, label, sortOrder | distinct normalised product sizes per brand |
| `condition_mappings` | code, label, gradeLetter, description, filterGroup, sortOrder | migration (D7 labels) |

Seed script `npm run catalog:seed`: reads the taxonomy (`tracker`) and `products` tables of the product database (`value-lens`, schema `keepa`, same RDS instance; connection via `CATALOG_SOURCE_DB_*`, read only) and upserts into the earthdna catalog tables by slug / sku; rows missing from the source become `isActive = false`; never deletes. Safe to re-run any time (the pull is still loading). CSV fallback `--taxonomy <csv> --products <csv>`. Column mapping lives in one place (`catalog-import.ts`). The API never queries the source database.

Size normalisation (source sizes are raw text: `8`, `8.5`, `10 Wide`, `9-10`, `Medium`): numeric and half sizes within 1–20 become the label; `Wide` is stripped; ranges, words and multi-system strings are skipped. The raw value is kept on `catalog_products.sizeRaw`.

## 2. Settings (env, all with defaults)
| Key | Default | Meaning |
|---|---|---|
| `CATALOG_SOURCE_DB_HOST/PORT/USERNAME/PASSWORD/NAME` | unset | seed script only; read-only connection to the product database |
| `CATALOG_MUTED_ENDPOINTS` | categories | comma list among `models,colours,categories,options` to answer 404 (app does not use them yet) |
| `CATALOG_LIST_MAX` | 500 | hard cap on list size |
| `SHOE_VALUE_PLACEHOLDER` | true | fill value / recommendation / CO2e with Figma placeholders on create |
| `SHOE_THUMBNAIL_VIEW` | right | which scan view becomes the My Shoes thumbnail |

## 3. Endpoints

### Shared body — `ShoeDetailsDto` (revised 2026-10-07: five fields only)
```json
{ "brandId": "uuid", "model": "Cloudmonster 2", "color": "Black", "sizeId": "uuid", "gender": "women" }
```
Confirm: every field optional; the predicted brand, model and colour are used for whatever is absent. Reject: `brandId`, `model`, `color`, `sizeId` required; `gender` optional.
Limits: model ≤ 150, color ≤ 100, trimmed; gender ∈ men, women, unisex, kids. Unknown or inactive ids → 400 `UNKNOWN_BRAND` / `UNKNOWN_SIZE`. Category, subCategory, condition and material are never in the body: they come from the F2 result.

### How the five fields are stored and returned
| Field | Stored on `shoes` | Returned to the app |
|---|---|---|
| brand | `brandId` (FK catalog_brands, null when the ShoeDNA brand is not in the catalog) + `brand` text (always set, display name) | `"brand": { "id": "uuid|null", "name": "On Running" }` |
| model | `model` varchar(150) | `"model": "Cloudmonster 2"` |
| color | `colorway` varchar(100) | `"color": "Black"` |
| size | `sizeId` (FK catalog_sizes) + `size` text label | `"size": { "id": "uuid", "label": "7.5" }` |
| gender | `gender` enum | `"gender": "women"` |
Prefill for the form: the results view carries `suggested: { brandId, brand }` per shoe (ShoeDNA brand matched to the catalog by slug), so the dropdown can be preselected; the other four are empty.

### Results view (E11 extended; also the response of E12 and E13)
```json
{ "scanId": "uuid", "status": "review", "allResolved": true,
  "reviewed": { "done": 1, "total": 2 },
  "shoes": [
    { "shoeId": "uuid", "position": 1, "label": "Shoe 01", "status": "identified",
      "review": "confirmed", "myShoeId": "uuid",
      "result": { "brand": "On Running", "matchPercent": 94, "condition": { "code": "C2", "label": "Lightly Worn" }, "…": "…" } },
    { "shoeId": "uuid", "position": 2, "label": "Shoe 02", "status": "identified",
      "review": null, "myShoeId": null, "result": { "…": "…" } } ] }
```
`status` becomes `completed` when `done == total`.

| # | Method + path | Body | Success | Errors |
|---|---|---|---|---|
| E11+ | `GET /scans/{scanId}/results` | — | 200 results view | 404 |
| E12 | `POST /scans/{scanId}/shoes/{shoeId}/confirm` | ShoeDetailsDto, all optional | 201 results view | 400 `BRAND_REQUIRED` (no brand in result or body) · 400 `UNKNOWN_BRAND` / `UNKNOWN_SIZE` · 404 · 409 `NOT_IN_REVIEW` · 409 `ALREADY_REVIEWED` · 409 `NO_RESULT` |
| E13 | `POST /scans/{scanId}/shoes/{shoeId}/reject` | ShoeDetailsDto, brandId + model + color + sizeId required | 201 results view | 400 validation · 400 `UNKNOWN_BRAND` / `UNKNOWN_SIZE` · 404 · 409 `NOT_IN_REVIEW` · 409 `ALREADY_REVIEWED` · 409 `NO_RESULT` |
| E10+ | `POST /scans/{scanId}/shoes/{shoeId}/result` (F2, extended) | adds optional `category`, `subCategory`, `material` | unchanged | unchanged |
| E14 | `GET /catalog/brands?q=` | — | 200 `{ items: [{ id, name, slug }] }` A→Z | — |
| E15 | `GET /catalog/sizes?brandId=` | — | 200 `{ items: [{ id, label }] }` numeric order; generic list when brand has none | 400 bad uuid |
| E16 | `GET /catalog/categories` | — | 200 `{ items: [{ id, name, slug, subcategories: [{ id, name, slug }] }] }` — muted by default (not used by the form) | — |
| E17 | `GET /catalog/models?brandId=&q=` | — | 200 `{ items: [{ model, modelCode }] }` | 400 brandId required |
| E18 | `GET /catalog/colours?brandId=&model=` | — | 200 `{ items: [{ colour }] }` | 400 |
| E19 | `GET /catalog/options` | — | 200 `{ genders: ["men","women","unisex","kids"] }` | — |

Muted catalog routes answer 404 `ENDPOINT_MUTED`. Error body: `{ statusCode, timestamp, path, message, code, details? }`.

`GET /scans?status=review` (E2, exists) lists the sessions ready for review.

## 4. Behaviour

- **Review transaction** (confirm and reject share one path): lock the scan row (`findOwnedScan(…, lock)`), check status ∈ {`review`} (also `processing` when this shoe already has a result, so a slow sibling shoe never blocks review), load the shoe and its result, refuse if already reviewed or no result, resolve catalog ids, overlay body on result (body wins), require a brand, insert `shoes` row, insert `shoe_feedback` row, set `scan_shoes.status`, recompute `reviewed`, flip `scans.status` to `completed` when done == total, `touchScan`, build the results view inside the transaction.
- **Overlay rule**: brand = body `brandId` if present, else the ShoeDNA brand (catalog-matched by slug when possible; "Unknown" counts as none → 400 `BRAND_REQUIRED`); model and color = body value, else the predicted value, else null; size and gender = body value or null. When the body changes the brand the predicted sub-brand is dropped. Category, subCategory, condition, material = F2 result as stored, never from the body.
- **Feedback `original`** = the F2 result row as stored (brand, subBrand, model, colorway, confidence, conditionCode, modelVersion, candidates). **`answer`** = the resolved final fields. `type` = `corrected` for E13 and for an E12 that changed the brand, else `confirmed`.
- **Placeholders** (`SHOE_VALUE_PLACEHOLDER=true`): `recommendedAction`, `resaleMin/Max`, `demandNote`, `recommendationReason`, `co2eKg` picked deterministically from the Figma option set by hashing the shoe id, so the same shoe always shows the same numbers; `valueSource = static`, `valueComputedAt = now`.
- **Thumbnail**: key of the `SHOE_THUMBNAIL_VIEW` photo, else the first photo by view order.
- **Catalog match**: after overlay, if brand + model (+ colour, + size label) match a `catalog_products` row, store `catalogProductId` and `msrp`; a miss stores nulls, never an error.
- **Account deletion**: `ShoeReviewService.anonymiseForUser(userId)` sets `shoe_feedback.userId` null; `shoes` rows for the user are deleted; called by the future account-deletion flow before the user row goes.
- **Catalog reads**: plain repository queries, `isActive = true`, ordered by name then id; results capped by `CATALOG_LIST_MAX`.

## 5. Testable properties (PBT-01)
| ID | Component | Property | Category |
|---|---|---|---|
| P1 | `overlayDetails(result, body)` | each output field = body value if defined, else result value; output never has a field that neither had | Oracle |
| P2 | `reviewedCount(shoes)` | done = count of confirmed + rejected; done ≤ total; total = shoes.length | Invariant |
| P3 | `isCompleted(shoes)` | true ⇔ total > 0 and done == total | Oracle |
| P4 | `placeholderFor(shoeId)` | deterministic for the same id; result always one of the Figma options; min ≤ max | Invariant |
| P5 | `validateDetails(mode, dto)` | reject mode: missing any of brand/model/color/size ⇔ error; confirm mode: never a missing-field error | Oracle |
| P6 | `importTaxonomy(rows)` | slugs unique; every input row maps to one brand, one category, one subcategory; re-import of same rows = no change | Idempotence |
| P7 | Review state machine | random confirm/reject sequences over N shoes against an in-memory model: exactly one `shoes` row per shoe, second review always rejected, completed ⇔ all reviewed | Stateful (PBT-06) |
| P8 | `sizeOrder(labels)` | numeric sort with half sizes ("7", "7.5", "10") stable and total | Invariant |

Pure functions live in `review-rules.ts` and `catalog-rules.ts` with no Nest or DB imports.

## 6. Security mapping (enabled baseline)
| Rule | How F3 meets it |
|---|---|
| SECURITY-05 input | class-validator DTO, enums for gender/condition, UUID params and query ids, string length caps, `q` capped at 50 chars |
| SECURITY-08 access | `JwtAuthGuard` on both controllers; ownership via `findOwnedScan`; `shoes` and feedback always written with the caller's userId |
| SECURITY-03 logging | log scan/shoe/myShoe ids and outcome; never tokens or free-text user input |
| SECURITY-15 errors | one transaction per review; stable error codes; catalog miss is not an error |
| SECURITY-11 throttling | confirm/reject 30/min per user; catalog 120/min |
| SECURITY-09 | no vendor names, paths or credentials in code; seed script takes file paths as arguments |
