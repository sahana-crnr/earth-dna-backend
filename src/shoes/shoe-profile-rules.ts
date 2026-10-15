// Pure F5 rules (features/F5-shoe-profile/how-to.md §1). No Nest, TypeORM or
// AWS imports so every function is property-tested directly, like
// review-rules.ts (F3).
import {
  MATERIAL_PARTS,
  type ActionTaken,
  type ConditionCode,
  type Gender,
  type MaterialPart,
  type ValueSource,
} from '../scan/scan.types';

// ─── F5-P4: material profile placeholder (F5-D3) ─────────────────────────────

export interface MaterialRow {
  part: MaterialPart;
  material: string;
  source: ValueSource;
}

/** Figma Shoe_Profile values; one set per shoe type, default = athletic. */
const MATERIALS: Record<string, Record<MaterialPart, string>> = {
  'athletic-shoes': {
    upper: 'Mesh / Synthetic Leather',
    midsole: 'Air-Sole Cushioning / EVA',
    outsole: 'Rubber Waffle (75% natural)',
    laces: 'Recycled Polyester',
  },
  'casual-shoes': {
    upper: 'Canvas / Leather',
    midsole: 'EVA Foam',
    outsole: 'Vulcanised Rubber',
    laces: 'Cotton',
  },
  'dress-shoes': {
    upper: 'Full-grain Leather',
    midsole: 'Leather Welt',
    outsole: 'Leather / Rubber Heel',
    laces: 'Waxed Cotton',
  },
  boots: {
    upper: 'Leather / Nubuck',
    midsole: 'PU Foam',
    outsole: 'Lugged Rubber',
    laces: 'Nylon',
  },
  sandals: {
    upper: 'Synthetic Straps',
    midsole: 'EVA Footbed',
    outsole: 'Rubber',
    laces: 'None',
  },
  slippers: {
    upper: 'Fleece / Wool',
    midsole: 'Memory Foam',
    outsole: 'TPR',
    laces: 'None',
  },
};

/** Four rows for any input (unknown or null type → athletic set). */
export function materialsFor(shoeTypeSlug: string | null): MaterialRow[] {
  const key = shoeTypeSlug ?? '';
  // Own keys only: 'constructor' or '__proto__' must not reach Object.prototype.
  const set = Object.hasOwn(MATERIALS, key)
    ? MATERIALS[key]
    : MATERIALS['athletic-shoes'];
  return MATERIAL_PARTS.map((part) => ({
    part,
    material: set[part],
    source: 'static' as const,
  }));
}

// ─── condition view (F5-D5) ──────────────────────────────────────────────────

export interface ConditionMappingRow {
  code: ConditionCode;
  label: string;
  gradeLetter: string;
  description: string;
  filterGroup: string;
}

export interface ConditionView {
  code: ConditionCode | null;
  grade: string | null;
  label: string | null;
  description: string | null;
  filterGroup: string | null;
}

export function conditionViewFor(
  code: ConditionCode | null,
  mappings: readonly ConditionMappingRow[],
): ConditionView {
  const row = code ? mappings.find((m) => m.code === code) : undefined;
  return {
    code,
    grade: row?.gradeLetter ?? null,
    label: row?.label ?? null,
    description: row?.description ?? null,
    filterGroup: row?.filterGroup ?? null,
  };
}

// ─── F5-P3: photos ───────────────────────────────────────────────────────────

export interface PhotoRef {
  id: string;
  sortOrder: number;
  createdAt: Date;
}

/** Lowest sortOrder (then oldest) among the photos that are not `removedId`;
 *  null when nothing is left. */
export function nextPrimary(
  photos: readonly PhotoRef[],
  removedId: string | null,
): string | null {
  const rest = photos.filter((p) => p.id !== removedId);
  if (rest.length === 0) return null;
  const sorted = [...rest].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  return sorted[0].id;
}

/** A shoe always keeps at least one photo (Figma card needs one). */
export function canDeletePhoto(photoCount: number): boolean {
  return photoCount > 1;
}

/** Next sortOrder for an appended photo. */
export function nextSortOrder(
  photos: readonly { sortOrder: number }[],
): number {
  return photos.reduce((max, p) => Math.max(max, p.sortOrder + 1), 0);
}

// ─── F5-P1: edit overlay (F5-D6, D7, D9) ─────────────────────────────────────

/** Display values already resolved by the service (catalog ids → rows). */
export interface EditInput {
  brandId?: string | null;
  brand?: string | null;
  model?: string | null;
  color?: string | null;
  sizeId?: string | null;
  size?: string | null;
  shoeTypeId?: string | null;
  shoeType?: string | null;
  gender?: Gender | null;
  actionTaken?: ActionTaken;
  primaryPhotoId?: string | null;
}

export interface EditableShoe {
  brandId: string | null;
  brand: string;
  model: string | null;
  colorway: string | null;
  sizeId: string | null;
  size: string | null;
  shoeTypeId: string | null;
  shoeType: string | null;
  gender: Gender | null;
  actionTaken: ActionTaken;
  actionTakenAt: Date | null;
  primaryPhotoId: string | null;
}

export type EditField = keyof EditableShoe;

export interface EditResult {
  next: EditableShoe;
  changed: Set<EditField>;
  /** brand / model / colour / size changed → catalog product rematch. */
  rematch: boolean;
  /** brand changed → value recompute while the source is static. */
  revalue: boolean;
}

const clean = (v: string | null | undefined): string | null => {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/**
 * Applies only the fields present on `input` (undefined = untouched; null =
 * clear where the column allows it). Never invents a value. `now` stamps
 * actionTakenAt when actionTaken changes to a real action.
 */
export function applyEdit(
  shoe: EditableShoe,
  input: EditInput,
  now: Date,
): EditResult {
  const next: EditableShoe = { ...shoe };
  const changed = new Set<EditField>();
  const set = <K extends EditField>(k: K, v: EditableShoe[K]) => {
    if (next[k] !== v) {
      next[k] = v;
      changed.add(k);
    }
  };
  if (input.brandId !== undefined && input.brand !== undefined) {
    const name = clean(input.brand);
    if (name) {
      set('brandId', input.brandId);
      set('brand', name);
    }
  }
  if (input.model !== undefined) set('model', clean(input.model));
  if (input.color !== undefined) set('colorway', clean(input.color));
  if (input.sizeId !== undefined && input.size !== undefined) {
    set('sizeId', input.sizeId);
    set('size', clean(input.size));
  }
  if (input.shoeTypeId !== undefined && input.shoeType !== undefined) {
    set('shoeTypeId', input.shoeTypeId);
    set('shoeType', clean(input.shoeType));
  }
  if (input.gender !== undefined) set('gender', input.gender);
  if (input.actionTaken !== undefined) {
    const before = next.actionTaken;
    set('actionTaken', input.actionTaken);
    if (before !== input.actionTaken) {
      set('actionTakenAt', input.actionTaken === 'none' ? null : now);
    }
  }
  if (input.primaryPhotoId !== undefined) {
    set('primaryPhotoId', input.primaryPhotoId);
  }
  const rematch = (['brand', 'model', 'colorway', 'size'] as EditField[]).some(
    (f) => changed.has(f),
  );
  return { next, changed, rematch, revalue: changed.has('brand') };
}
