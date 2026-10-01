// Pure F1 scan-session rules. No Nest, TypeORM or AWS imports, so every
// function here can be property-tested directly (how-to.md §6, P1–P6).
import { SHOE_VIEWS, isShoeView, type ShoeView } from './scan.types';
import type { PhotoType } from '../config/scan.config';

// ─── P1: shoe completeness ───────────────────────────────────────────────────

export interface ShoeState {
  complete: boolean;
  /** Missing views in canonical capture order. */
  missing: ShoeView[];
}

/** A shoe is complete when it has all four distinct views. */
export function computeShoeState(views: readonly ShoeView[]): ShoeState {
  const have = new Set(views);
  const missing = SHOE_VIEWS.filter((v) => !have.has(v));
  return { complete: missing.length === 0, missing };
}

// ─── P2: labels ──────────────────────────────────────────────────────────────

/** 1 → "Shoe 01", 12 → "Shoe 12". Derived, never stored (F1-D6). */
export function labelFor(position: number): string {
  if (!Number.isInteger(position) || position < 1) {
    throw new RangeError(
      `position must be a positive integer, got ${position}`,
    );
  }
  return `Shoe ${String(position).padStart(2, '0')}`;
}

/** Inverse of labelFor; null when the text is not a shoe label. */
export function positionFromLabel(label: string): number | null {
  const m = /^Shoe (\d{2,})$/.exec(label);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return n >= 1 && labelFor(n) === label ? n : null;
}

// ─── P3: renumbering ─────────────────────────────────────────────────────────

/**
 * Given ids in their current position order, returns the new contiguous
 * position for each (F1-D7: removing Shoe 02 makes Shoe 03 the new Shoe 02).
 */
export function renumber<T>(idsInOrder: readonly T[]): Map<T, number> {
  const out = new Map<T, number>();
  idsInOrder.forEach((id, i) => out.set(id, i + 1));
  return out;
}

/** Sorts shoes by position; ties keep input order (stable). */
export function orderByPosition<S extends { position: number }>(
  shoes: readonly S[],
): S[] {
  return [...shoes].sort((a, b) => a.position - b.position);
}

// ─── P4: finish rule ─────────────────────────────────────────────────────────

export interface ShoeViews {
  id: string;
  position: number;
  views: readonly ShoeView[];
}

export interface IncompleteShoe {
  shoeId: string;
  label: string;
  missing: ShoeView[];
}

/** Shoes that block Finish: partial AND empty ones (F1-D8, Q18). */
export function incompleteShoes(shoes: readonly ShoeViews[]): IncompleteShoe[] {
  return orderByPosition(shoes)
    .map((s) => ({ s, state: computeShoeState(s.views) }))
    .filter(({ state }) => !state.complete)
    .map(({ s, state }) => ({
      shoeId: s.id,
      label: labelFor(s.position),
      missing: state.missing,
    }));
}

/** Finish needs at least one shoe and every shoe complete. */
export function canFinish(shoes: readonly ShoeViews[]): boolean {
  return shoes.length > 0 && incompleteShoes(shoes).length === 0;
}

// ─── P6: file type from bytes ────────────────────────────────────────────────

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Detects the image type from the first bytes. The file name and the declared
 * Content-Type are ignored on purpose: both are client-controlled.
 */
export function sniffImageType(bytes: Uint8Array): PhotoType | null {
  const starts = (magic: number[]) =>
    bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
  if (starts(JPEG_MAGIC)) return 'jpeg';
  if (starts(PNG_MAGIC)) return 'png';
  return null;
}

export const CONTENT_TYPE: Record<PhotoType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export const FILE_EXT: Record<PhotoType, string> = {
  jpeg: 'jpg',
  png: 'png',
};

/** S3 key layout (data-model.md P1). */
export function scanPhotoKey(
  scanId: string,
  shoeId: string,
  view: ShoeView,
  type: PhotoType,
): string {
  return `scans/${scanId}/${shoeId}/${view}.${FILE_EXT[type]}`;
}

// ─── P5: album manifest ──────────────────────────────────────────────────────

export type PhotoRejection =
  | 'FILE_REQUIRED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE';

export type AlbumShoeError =
  | 'EMPTY_SHOE'
  | 'INVALID_VIEW'
  | 'DUPLICATE_VIEW'
  | 'UNKNOWN_FILE'
  | 'FILE_USED_TWICE'
  | 'SHOE_LIMIT_REACHED'
  | PhotoRejection;

export interface AlbumManifestShoe {
  ref: string;
  files: readonly { field: string; view: string }[];
}

export interface AlbumFileInfo {
  size: number;
  type: PhotoType | null;
}

export interface AlbumLimits {
  photoMaxBytes: number;
  allowedTypes: readonly PhotoType[];
}

export type AlbumShoeDecision =
  | {
      ref: string;
      accepted: true;
      files: { field: string; view: ShoeView; type: PhotoType }[];
    }
  | { ref: string; accepted: false; error: AlbumShoeError; detail: string };

/** Size and type check shared by single upload and album batch. */
export function checkPhoto(
  file: AlbumFileInfo | undefined,
  limits: AlbumLimits,
): PhotoRejection | null {
  if (!file || file.size === 0) return 'FILE_REQUIRED';
  if (file.size > limits.photoMaxBytes) return 'FILE_TOO_LARGE';
  if (!file.type || !limits.allowedTypes.includes(file.type)) {
    return 'UNSUPPORTED_TYPE';
  }
  return null;
}

/**
 * Decides per shoe whether an album batch entry can be saved (F1-D13: partial
 * success). Shoes are judged in manifest order; accepted shoes use up
 * `remainingCapacity` (session shoe cap minus shoes already in the session).
 * The caller enforces batch-level caps (shoes/photos per batch) before this.
 */
export function decideAlbumShoes(
  shoes: readonly AlbumManifestShoe[],
  files: ReadonlyMap<string, AlbumFileInfo>,
  limits: AlbumLimits,
  remainingCapacity: number,
): AlbumShoeDecision[] {
  // A file part may belong to exactly one (shoe, view). Any part referenced
  // more than once anywhere in the manifest rejects every shoe that uses it,
  // so the outcome never depends on manifest order.
  const refCount = new Map<string, number>();
  for (const shoe of shoes) {
    for (const f of shoe.files) {
      refCount.set(f.field, (refCount.get(f.field) ?? 0) + 1);
    }
  }
  let capacity = Math.max(0, remainingCapacity);

  return shoes.map((shoe): AlbumShoeDecision => {
    const reject = (error: AlbumShoeError, detail: string) =>
      ({ ref: shoe.ref, accepted: false, error, detail }) as const;

    if (shoe.files.length === 0) return reject('EMPTY_SHOE', 'no files');

    const seenViews = new Set<string>();
    const accepted: { field: string; view: ShoeView; type: PhotoType }[] = [];
    for (const f of shoe.files) {
      if (!isShoeView(f.view)) {
        return reject('INVALID_VIEW', `unknown view '${f.view}'`);
      }
      if (seenViews.has(f.view)) {
        return reject('DUPLICATE_VIEW', `view '${f.view}' appears twice`);
      }
      seenViews.add(f.view);
      if ((refCount.get(f.field) ?? 0) > 1) {
        return reject('FILE_USED_TWICE', `file '${f.field}' used twice`);
      }
      const info = files.get(f.field);
      if (!info) return reject('UNKNOWN_FILE', `no file part '${f.field}'`);
      const bad = checkPhoto(info, limits);
      if (bad) return reject(bad, `file '${f.field}'`);
      accepted.push({ field: f.field, view: f.view, type: info.type! });
    }

    if (capacity < 1) return reject('SHOE_LIMIT_REACHED', 'session is full');
    capacity -= 1;
    return { ref: shoe.ref, accepted: true, files: accepted };
  });
}
