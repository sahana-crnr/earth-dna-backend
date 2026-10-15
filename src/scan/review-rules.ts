// Pure F3 review rules (features/F3-match-feedback/how-to.md §5). No Nest,
// TypeORM or AWS imports so each function is property-tested directly, like
// scan-rules.ts (F1) and result-rules.ts (F2).
import {
  type ConditionCode,
  type Gender,
  type RecommendedAction,
  type ResaleBucket,
  type ReviewState,
  type ScanShoeStatus,
} from './scan.types';

// ─── F3-P1: overlay (body wins, prediction fills, never invents) ─────────────

/** The five fields the form can send (F3-D5), already resolved to display
 *  values by the service (catalog ids → names). */
export interface DetailsAnswer {
  brand?: string | null;
  model?: string | null;
  color?: string | null;
  size?: string | null;
  gender?: Gender | null;
}

/** What the F2 result contributes. Only `brand` can be overridden by the body;
 *  the rest is carried through untouched (F3-D5, D8). */
export interface PredictedIdentity {
  brand: string | null;
  model: string | null;
  colorway: string | null;
  subBrand: string | null;
  category: string | null;
  subCategory: string | null;
  conditionCode: ConditionCode | null;
  material: string | null;
}

export interface ResolvedIdentity {
  brand: string | null;
  subBrand: string | null;
  category: string | null;
  subCategory: string | null;
  conditionCode: ConditionCode | null;
  material: string | null;
  model: string | null;
  color: string | null;
  size: string | null;
  gender: Gender | null;
}

const clean = (v: string | null | undefined): string | null => {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/** Body value when non-blank, else the fallback (itself cleaned). */
function pick(body: string | null | undefined, fallback: string | null) {
  return clean(body) ?? clean(fallback);
}

/** ShoeDNA answers "Unknown" rather than an empty brand (team note); for the
 *  review it is the same as no brand, so the user is asked to pick one. */
export function isUnknownBrand(brand: string | null | undefined): boolean {
  const v = clean(brand);
  return v === null || v.toLowerCase() === 'unknown';
}

/**
 * Body value if present (trimmed, non-empty), else the predicted value, else
 * null — for brand, model and colour. Size and gender exist only in the body.
 * Category, subCategory, conditionCode and material are never in the body and
 * are copied from the prediction as they are (F3-D5, D8). A predicted brand of
 * "Unknown" counts as absent. When the body changes the brand, the predicted
 * sub-brand no longer applies and is dropped.
 */
export function overlayDetails(
  predicted: PredictedIdentity,
  body: DetailsAnswer,
): ResolvedIdentity {
  const predictedBrand = isUnknownBrand(predicted.brand)
    ? null
    : clean(predicted.brand);
  const brand = pick(body.brand, predictedBrand);
  const brandChanged =
    clean(body.brand) !== null &&
    (predictedBrand === null ||
      clean(body.brand)!.toLowerCase() !== predictedBrand.toLowerCase());
  return {
    brand,
    subBrand: brandChanged ? null : clean(predicted.subBrand),
    category: clean(predicted.category),
    subCategory: clean(predicted.subCategory),
    conditionCode: predicted.conditionCode,
    material: clean(predicted.material),
    model: pick(body.model, predicted.model),
    color: pick(body.color, predicted.colorway),
    size: pick(body.size, null),
    gender: body.gender ?? null,
  };
}

/** True when the user's answer names a different brand than the prediction. */
export function brandCorrected(
  predictedBrand: string | null,
  answerBrand: string | null,
): boolean {
  const p = isUnknownBrand(predictedBrand) ? null : clean(predictedBrand);
  const a = clean(answerBrand);
  if (a === null) return false;
  return p === null || a.toLowerCase() !== p.toLowerCase();
}

// ─── F3-P2 / P3: reviewed counter and completion ─────────────────────────────

const REVIEWED: readonly ScanShoeStatus[] = ['confirmed', 'rejected'];

export function reviewStateFor(status: ScanShoeStatus): ReviewState | null {
  return status === 'confirmed' || status === 'rejected' ? status : null;
}

export interface ReviewedCount {
  done: number;
  total: number;
}

/** done = shoes confirmed or rejected; total = every shoe in the session. */
export function reviewedCount(
  shoes: readonly { status: ScanShoeStatus }[],
): ReviewedCount {
  const done = shoes.filter((s) => REVIEWED.includes(s.status)).length;
  return { done, total: shoes.length };
}

/** A session is completed once every shoe has been reviewed (and there is at
 *  least one shoe — an empty session cannot complete). */
export function isCompleted(
  shoes: readonly { status: ScanShoeStatus }[],
): boolean {
  const { done, total } = reviewedCount(shoes);
  return total > 0 && done === total;
}

// ─── F3-P5: required fields per mode ─────────────────────────────────────────

export type ReviewMode = 'confirm' | 'reject';

export const REJECT_REQUIRED = ['brand', 'model', 'color', 'size'] as const;
export type RequiredField = (typeof REJECT_REQUIRED)[number];

/**
 * Reject needs the user's full answer (F3-D5); confirm needs nothing because
 * the prediction fills the gaps. Returns the missing field names, in order.
 * Mirrors the DTO validation so the rule is testable without Nest.
 */
export function missingFields(
  mode: ReviewMode,
  answer: DetailsAnswer,
): RequiredField[] {
  if (mode === 'confirm') return [];
  return REJECT_REQUIRED.filter((f) => {
    const v = answer[f];
    return v === undefined || v === null || v.trim() === '';
  });
}

// ─── F3-P4: value placeholders (until the ValueLens endpoint exists) ────────
// CO2e / carbon footprint is out of scope (decided 2026-10-09, tracker T28).

export interface ValuePlaceholder {
  recommendedAction: RecommendedAction;
  resaleMin: number | null;
  resaleMax: number | null;
  resaleBucket: ResaleBucket | null;
  demandNote: string | null;
  recommendationReason: string;
}

/** Exactly the option set the Figma shows (My Shoes cards + Shoe Profile). */
export const VALUE_PLACEHOLDERS: readonly ValuePlaceholder[] = [
  {
    recommendedAction: 'resell',
    resaleMin: 65,
    resaleMax: 90,
    resaleBucket: 'from_50_to_100',
    demandNote: 'High demand silhouette',
    recommendationReason:
      'Due to high demand and exceptional condition, keeping this pair in circulation maximizes value.',
  },
  {
    recommendedAction: 'repair',
    resaleMin: 25,
    resaleMax: 40,
    resaleBucket: 'from_25_to_50',
    demandNote: null,
    recommendationReason:
      'A small repair restores most of the resale value of this pair.',
  },
  {
    recommendedAction: 'resell',
    resaleMin: 35,
    resaleMax: 55,
    resaleBucket: 'from_50_to_100',
    demandNote: 'Steady demand',
    recommendationReason:
      'Good condition and steady demand make resale the best next step.',
  },
  {
    recommendedAction: 'recycle',
    resaleMin: null,
    resaleMax: null,
    resaleBucket: null,
    demandNote: null,
    recommendationReason:
      'Wear is beyond resale or repair; recycling recovers the materials.',
  },
];

/** FNV-1a 32-bit over the id: stable across restarts and machines. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic: the same shoe id always gets the same placeholder. */
export function placeholderFor(shoeId: string): ValuePlaceholder {
  return VALUE_PLACEHOLDERS[stableHash(shoeId) % VALUE_PLACEHOLDERS.length];
}

/** Figma buckets (design skips 20–25, tracker T18): derived from resaleMax. */
export function resaleBucketFor(resaleMax: number | null): ResaleBucket | null {
  if (resaleMax === null || !Number.isFinite(resaleMax)) return null;
  if (resaleMax < 20) return 'under_20';
  if (resaleMax <= 50) return 'from_25_to_50';
  if (resaleMax <= 100) return 'from_50_to_100';
  return 'over_100';
}
