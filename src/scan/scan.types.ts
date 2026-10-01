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
