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
