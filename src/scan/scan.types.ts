// Shared F1 value sets. Arrays are the single source for enum columns, DTO
// validation and the pure rules, so the three can never drift apart.

/** Capture order used everywhere (UI progress, `missing` lists). */
export const SHOE_VIEWS = ['top', 'right', 'left', 'sole'] as const;
export type ShoeView = (typeof SHOE_VIEWS)[number];

export const SCAN_STATUSES = [
  'draft',
  'processing',
  'review',
  'completed',
  'abandoned',
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SCAN_SOURCES = ['camera', 'album'] as const;
export type ScanSource = (typeof SCAN_SOURCES)[number];

export const SCAN_SHOE_STATUSES = [
  'capturing',
  'complete',
  'analyzing',
  'identified',
  'failed',
  'confirmed',
  'rejected',
] as const;
export type ScanShoeStatus = (typeof SCAN_SHOE_STATUSES)[number];

export const UPLOAD_STATUSES = ['pending', 'uploaded'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export function isShoeView(v: unknown): v is ShoeView {
  return typeof v === 'string' && (SHOE_VIEWS as readonly string[]).includes(v);
}

// ─── F2 identification results ───────────────────────────────────────────────

/** Who produced a result. The app submits `device`; `server` is for the
 *  server-side ShoeDNA endpoint, which no route writes yet. */
export const IDENTIFICATION_SOURCES = ['device', 'server'] as const;
export type IdentificationSource = (typeof IDENTIFICATION_SOURCES)[number];

/** Raw ShoeDNA condition grade. The label is derived in result-rules.ts and
 *  never stored, so a change to the (still provisional) scale needs no migration. */
export const CONDITION_CODES = ['C1', 'C2', 'C3', 'C4', 'C5'] as const;
export type ConditionCode = (typeof CONDITION_CODES)[number];

/** Terminal outcome of one identification attempt. Kept on the result row
 *  rather than read off the shoe, because F3 overwrites the shoe status with
 *  `confirmed`/`rejected` and would otherwise erase whether it ever succeeded. */
export const IDENTIFICATION_OUTCOMES = ['identified', 'failed'] as const;
export type IdentificationOutcome = (typeof IDENTIFICATION_OUTCOMES)[number];

/** Per-shoe state the "Scan processing" screen renders. */
export const RESULT_STATUSES = ['waiting', 'identified', 'failed'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

// ─── F3 review, My Shoes and catalog value sets ──────────────────────────────

/** Gender of the pair as the user states it (F3-D5). An enum, not a table. */
export const GENDERS = ['men', 'women', 'unisex', 'kids'] as const;
export type Gender = (typeof GENDERS)[number];

/** What a review produced for training: the prediction stood, or the user
 *  corrected it (F3-D14). Written once per review, never updated. */
export const FEEDBACK_TYPES = ['confirmed', 'corrected'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** Review state of a scan shoe as the app renders it; derived from
 *  scan_shoes.status, never stored separately. */
export const REVIEW_STATES = ['confirmed', 'rejected'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const RECOMMENDED_ACTIONS = [
  'resell',
  'repair',
  'donate',
  'recycle',
] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

export const ACTION_TAKEN = [
  'none',
  'resold',
  'repaired',
  'donated',
  'recycled',
] as const;
export type ActionTaken = (typeof ACTION_TAKEN)[number];

/** Figma filter buckets; the design skips 20–25 (tracker T18). */
export const RESALE_BUCKETS = [
  'under_20',
  'from_25_to_50',
  'from_50_to_100',
  'over_100',
] as const;
export type ResaleBucket = (typeof RESALE_BUCKETS)[number];

/** Where a value on `shoes` came from: the static placeholder (now) or the
 *  ValueLens endpoint (F5/F7). */
export const VALUE_SOURCES = ['static', 'valuelens'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

export function isGender(v: unknown): v is Gender {
  return typeof v === 'string' && (GENDERS as readonly string[]).includes(v);
}
