// F1 scan-session rules. Every limit is an env setting with a safe default so
// product can change it without a code change (decisions F1-D2, D4, D5, D9, D11).
import { registerAs } from '@nestjs/config';
import { isShoeView, type ShoeView } from '../scan/scan.types';

export type PhotoType = 'jpeg' | 'png';

export interface ScanConfig {
  /** Max shoes in one session (camera flow). */
  maxShoes: number;
  /** Max shoes in one album batch (Figma: 3 pairs). */
  albumMaxShoes: number;
  /** Max photos in one album batch (Figma: 12). */
  albumMaxPhotos: number;
  /** Max bytes per photo (default 1 MB). */
  photoMaxBytes: number;
  /** Accepted photo types, detected from the file bytes. */
  photoAllowedTypes: PhotoType[];
  /** Max open drafts per user; 0 = unlimited. */
  maxOpenDrafts: number;
  /** Delete the S3 object when a photo or shoe is removed. */
  deleteObjectsOnRemove: boolean;
  /** Drafts idle this many days become abandoned. */
  draftAbandonDays: number;
  /** Lifetime of the signed thumbnail URLs in session responses. */
  photoUrlTtlSeconds: number;
  /** Max ranked candidates kept with one identification result (F2: "top-3"). */
  resultMaxCandidates: number;
  /** Max serialized bytes of the `raw` ShoeDNA passthrough blob (F2). */
  resultRawMaxBytes: number;
  /** F3: fill value / recommendation / CO2e on a new My Shoes entry with the
   *  Figma placeholder set until the ValueLens + CircularSort endpoints exist. */
  valuePlaceholder: boolean;
  /** F3: which captured view becomes the My Shoes thumbnail (F3-D3). */
  thumbnailView: ShoeView;
}

export default registerAs(
  'scan',
  (): ScanConfig => ({
    maxShoes: parsePositiveInt(process.env.SCAN_MAX_SHOES, 4),
    albumMaxShoes: parsePositiveInt(process.env.SCAN_ALBUM_MAX_SHOES, 3),
    albumMaxPhotos: parsePositiveInt(process.env.SCAN_ALBUM_MAX_PHOTOS, 12),
    photoMaxBytes: parsePositiveInt(process.env.SCAN_PHOTO_MAX_BYTES, 1048576),
    photoAllowedTypes: parsePhotoTypes(process.env.SCAN_PHOTO_ALLOWED_TYPES),
    maxOpenDrafts: parseNonNegativeInt(process.env.SCAN_MAX_OPEN_DRAFTS, 0),
    deleteObjectsOnRemove: parseBool(
      process.env.SCAN_DELETE_OBJECTS_ON_REMOVE,
      true,
    ),
    draftAbandonDays: parsePositiveInt(process.env.SCAN_DRAFT_ABANDON_DAYS, 30),
    photoUrlTtlSeconds: parsePositiveInt(
      process.env.SCAN_PHOTO_URL_TTL_SECONDS,
      900,
    ),
    resultMaxCandidates: parsePositiveInt(
      process.env.SCAN_RESULT_MAX_CANDIDATES,
      3,
    ),
    resultRawMaxBytes: parsePositiveInt(
      process.env.SCAN_RESULT_RAW_MAX_BYTES,
      8192,
    ),
    valuePlaceholder: parseBool(process.env.SHOE_VALUE_PLACEHOLDER, true),
    thumbnailView: parseView(process.env.SHOE_THUMBNAIL_VIEW, 'right'),
  }),
);

/** Invalid or missing values fall back to the default rather than 0/NaN. */
export function parsePositiveInt(raw: string | undefined, fallback: number) {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseNonNegativeInt(raw: string | undefined, fallback: number) {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/**
 * "jpeg,png" → ['jpeg','png']. "jpg" is accepted as an alias of jpeg (same
 * format). Unknown names are ignored; an empty result falls back to the default
 * so a typo can never disable uploads entirely.
 */
export function parsePhotoTypes(raw: string | undefined): PhotoType[] {
  const out = new Set<PhotoType>();
  for (const part of (raw ?? '').split(',')) {
    const v = part.trim().toLowerCase();
    if (v === 'jpeg' || v === 'jpg') out.add('jpeg');
    else if (v === 'png') out.add('png');
  }
  return out.size > 0 ? [...out] : ['jpeg', 'png'];
}

/** Unknown view names fall back, so a typo can never break thumbnails. */
export function parseView(
  raw: string | undefined,
  fallback: ShoeView,
): ShoeView {
  const v = (raw ?? '').trim().toLowerCase();
  return isShoeView(v) ? v : fallback;
}
