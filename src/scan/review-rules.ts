// Pure F3 review rules (features/F3-match-feedback/how-to.md §5). No Nest,
// TypeORM or AWS imports so each function is property-tested directly, like
// scan-rules.ts (F1) and result-rules.ts (F2).
import {
  SHOE_VIEWS,
  type ConditionCode,
  type Gender,
  type RecommendedAction,
  type ResaleBucket,
  type ReviewState,
  type ScanShoeStatus,
  type ShoeView,
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
  subBrand: string | null;
  category: string | null;
  subCategory: string | null;
  conditionCode: ConditionCode | null;
  material: string | null;
}

export interface ResolvedIdentity extends PredictedIdentity {
  brand: string | null;
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

/**
 * Body value if present (trimmed, non-empty), else the predicted value, else
 * null. Fields the form never carries (category, subCategory, conditionCode,
 * material) are copied from the prediction as they are.
 */
export function overlayDetails(
  predicted: PredictedIdentity,
  body: DetailsAnswer,
): ResolvedIdentity {
  return {
    brand: pick(body.brand, predicted.brand),
    subBrand: clean(predicted.subBrand),
    category: clean(predicted.category),
    subCategory: clean(predicted.subCategory),
    conditionCode: predicted.conditionCode,
    material: clean(predicted.material),
    model: pick(body.model, null),
    color: pick(body.color, null),
    size: pick(body.size, null),
    gender: body.gender ?? null,
  };
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

// ─── F3-P4: value placeholders (until ValueLens + CircularSort exist) ────────

export interface ValuePlaceholder {
  recommendedAction: RecommendedAction;
  resaleMin: number | null;
  resaleMax: number | null;
  resaleBucket: ResaleBucket | null;
  demandNote: string | null;
  recommendationReason: string;
  co2eKg: number;
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
    co2eKg: 12.4,
  },
  {
    recommendedAction: 'repair',
    resaleMin: 25,
    resaleMax: 40,
    resaleBucket: 'from_25_to_50',
    demandNote: null,
    recommendationReason:
      'A small repair restores most of the resale value of this pair.',
    co2eKg: 9.8,
  },
  {
    recommendedAction: 'resell',
    resaleMin: 35,
    resaleMax: 55,
    resaleBucket: 'from_50_to_100',
    demandNote: 'Steady demand',
    recommendationReason:
      'Good condition and steady demand make resale the best next step.',
    co2eKg: 11.2,
  },
  {
    recommendedAction: 'recycle',
    resaleMin: null,
    resaleMax: null,
    resaleBucket: null,
    demandNote: null,
    recommendationReason:
      'Wear is beyond resale or repair; recycling recovers the materials.',
    co2eKg: 6.5,
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

// ─── thumbnail ───────────────────────────────────────────────────────────────

/** The configured view's key, else the first captured view in canonical order,
 *  else null (a reviewed shoe always has 4 photos, but the rule is total). */
export function thumbnailKeyFor(
  photos: readonly { view: ShoeView; s3Key: string }[],
  preferred: ShoeView,
): string | null {
  const hit = photos.find((p) => p.view === preferred);
  if (hit) return hit.s3Key;
  for (const v of SHOE_VIEWS) {
    const p = photos.find((x) => x.view === v);
    if (p) return p.s3Key;
  }
  return null;
}
