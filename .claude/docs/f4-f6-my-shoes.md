# F4 + F6 — My Shoes list, filters and summary

Built by Nawaz (PR #14, merged to develop 2026-10-13). Merged into the F5 branch with two changes: CO2e removed everywhere (product decision 2026-10-09) and the card thumbnail now comes from the F5 `shoe_photos` primary row instead of the dropped `primaryPhotoS3Key`. Endpoints are numbered E31 / E32 so the team docs keep one sequence after F5's E21–E30.

## Screens
| Screen | What the backend provides |
|---|---|
| My Shoes list + Filters sheet | E31 `GET /shoes` with multi-select filters, newest first, paged |
| My Shoes header (Pairs Scanned, Potential Value) | E32 `GET /shoes/summary` |
| Home | no stats any more in the current design (F5-D25); "Recent Scans" = E31 with a small `limit` |

## Endpoints
All under `/api/v1`, JWT required, scoped to the caller, soft-deleted shoes excluded. Class throttle 60/min.

| # | Endpoint | Query | Success | Errors |
|---|---|---|---|---|
| E31 | `GET /shoes` | `actionTaken`, `condition`, `recommendedAction`, `resaleBucket` — each multi-select (`?x=a,b` or `?x=a&x=b`), OR within a filter, AND across filters; `limit` 1–100 (default 20), `offset` (default 0) | 200 `{ items: [card], total, limit, offset }` | 400 unknown value, unknown query key, bad paging |
| E32 | `GET /shoes/summary` | — | 200 `{ pairsScanned, potentialValue: { min, max, currency } \| null }` | — |

### Card (E31 item) = the F3 `myShoe` shape + `actionTaken` + `resaleBucket`
```json
{ "id": "…", "brand": { "id": "…", "name": "Nike" }, "subBrand": null, "category": "running_shoes", "subCategory": null,
  "model": "Air Max 90", "color": "Black", "size": { "id": "…", "label": "9" }, "gender": "men",
  "shoeType": { "id": "…", "name": "Athletic Shoes" },
  "condition": { "code": "C2", "label": "Lightly Worn" }, "material": null,
  "recommendedAction": "resell", "resale": { "min": 65, "max": 90, "currency": "USD" },
  "valueSource": "static", "thumbnailUrl": "https://…", "primaryPhotoId": "…", "createdAt": "…",
  "actionTaken": "none", "resaleBucket": "from_50_to_100" }
```

### Filter values
- `actionTaken`: none, resold, repaired, donated, recycled
- `recommendedAction`: resell, repair, donate, recycle
- `condition`: like_new, lightly_worn, heavily_worn (C3 + C4), not_wearable — slugs of the card labels
- `resaleBucket`: under_20, from_25_to_50, from_50_to_100, over_100

The current Figma Filters sheet shows only Action Taken and Recommended Action; the other two filters stay available.

## Summary rule
`pairsScanned` = every live shoe. `potentialValue` = sum of `resaleMin` / `resaleMax` over live shoes with `actionTaken = none` and a full range; `null` when no shoe qualifies (not 0). Currency fixed to USD. Open point for Divesh: F5-D23 said action taken has no effect on the summary for now; this implementation excludes acted-on pairs. One of the two rules should win before the app relies on the number.

## Code
`src/shoes/shoes-list.controller.ts`, `shoes-list.service.ts`, `shoe-view.mapper.ts` (card shape shared with the F3 review response), `shoes-rules.ts` (filters, multi-value parsing, summary), `dto/list-shoes-query.dto.ts`. Tests: `shoes-rules.pbt.spec.ts`, `shoes-list.controller.spec.ts`, `shoes-list.service.it.spec.ts`.
