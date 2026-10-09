// Pure catalog rules: slugs, display names, size normalisation and the import
// plan the seed script executes. No Nest or TypeORM imports (property-tested).
import { GENDERS, type Gender } from '../scan/scan.types';

// ─── names ───────────────────────────────────────────────────────────────────

/** "On Running" → "on-running"; "361°" → "361"; collapses runs of separators. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const KEEP_UPPER = new Set(['apl', 'dc', 'ecco', 'hoka', 'k-swiss', 'on']);

/** "new_balance" → "New Balance"; short all-caps brands stay upper. */
export function titleCase(slugOrName: string): string {
  const words = slugOrName.trim().replace(/[_-]+/g, ' ').split(/\s+/);
  return words
    .filter((w) => w.length > 0)
    .map((w) => {
      const lower = w.toLowerCase();
      if (KEEP_UPPER.has(lower)) return lower.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

// ─── sizes (F3-D13) ──────────────────────────────────────────────────────────

/**
 * Source sizes are raw retail text: "8", "8.5", "10 Wide", "9-10", "Medium",
 * "US: Men 14.5-15, Women 15.5-16". Keep whole and half sizes in 1..20, strip
 * a trailing width word, skip everything else. Returns the canonical label
 * ("7", "7.5") or null.
 */
export function normalizeSize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(
    /\b(wide|narrow|medium|regular|x-wide|xw|w|m|d|b|ee|e)\b\.?$/,
    '',
  );
  s = s.replace(/^(us|size)\s*:?\s*/, '').trim();
  const m = /^(\d{1,2})(?:\.(5|0))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const half = m[2] === '5';
  if (whole < 1 || whole > 20) return null;
  return half ? `${whole}.5` : `${whole}`;
}

/** Numeric order for labels produced by normalizeSize. */
export function sizeSortKey(label: string): number {
  const n = Number(label);
  return Number.isFinite(n) ? Math.round(n * 10) : Number.MAX_SAFE_INTEGER;
}

export function sizeOrder(labels: readonly string[]): string[] {
  return [...new Set(labels)].sort(
    (a, b) => sizeSortKey(a) - sizeSortKey(b) || a.localeCompare(b),
  );
}

/** The generic US list used when a brand has no sized products: 4..15 by halves. */
export function genericUsSizes(): string[] {
  const out: string[] = [];
  for (let n = 4; n <= 15; n += 1) {
    out.push(`${n}`);
    if (n < 15) out.push(`${n}.5`);
  }
  return out;
}

/**
 * Source model names often carry the listing's colour and size as suffixes:
 * "Ghost 13 Running Shoe - Black/Grey/Stormy - 9.5 Medium". Strip trailing
 * " - <segment>" parts that equal the row's colour or look like a size, so the
 * model dropdown (E17) shows "Ghost 13 Running Shoe" once, not per variant.
 */
export function cleanModel(
  model: string | null | undefined,
  colour: string | null | undefined,
  sizeRaw: string | null | undefined,
): string | null {
  const base = (model ?? '').trim();
  if (!base) return null;
  const parts = base.split(/\s+-\s+/);
  const col = (colour ?? '').trim().toLowerCase();
  const raw = (sizeRaw ?? '').trim().toLowerCase();
  while (parts.length > 1) {
    const last = parts[parts.length - 1].trim();
    const lower = last.toLowerCase();
    const isColour = col !== '' && lower === col;
    const isSize =
      lower === raw ||
      normalizeSize(last) !== null ||
      /^\d{1,2}(\.5)?(\s*-\s*\d{1,2}(\.5)?)?\s*(wide|narrow|medium|regular|w|m|d|b|x-wide)?$/.test(
        lower,
      ) ||
      /^(x?s|m|l|xl|xxl|one size|medium|wide|narrow)$/.test(lower);
    if (!isColour && !isSize) break;
    parts.pop();
  }
  return parts.join(' - ').trim() || base;
}

export function normalizeGender(raw: string | null | undefined): Gender | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'male' || v === 'mens') return 'men';
  if (v === 'female' || v === 'womens') return 'women';
  return (GENDERS as readonly string[]).includes(v) ? (v as Gender) : null;
}

// ─── import plan (F3-D12) ────────────────────────────────────────────────────

/** One taxonomy row from the source: category, optional subcategory, brand. */
export interface TaxonomyRow {
  category: string;
  subcategory: string | null;
  brand: string;
}

export interface ImportPlan {
  categories: { slug: string; name: string }[];
  subcategories: { categorySlug: string; slug: string; name: string }[];
  brands: { slug: string; name: string }[];
  links: { brandSlug: string; categorySlug: string; subcategorySlug: string }[];
  /** Rows dropped because category or brand was blank after slugging. */
  skipped: number;
}

/**
 * Rows → unique, slugged, sorted plan. Idempotent: the same rows always give
 * the same plan, and feeding the plan's own output back changes nothing.
 */
export function importTaxonomy(rows: readonly TaxonomyRow[]): ImportPlan {
  const categories = new Map<string, string>();
  const subcategories = new Map<
    string,
    { categorySlug: string; slug: string; name: string }
  >();
  const brands = new Map<string, string>();
  const links = new Map<
    string,
    { brandSlug: string; categorySlug: string; subcategorySlug: string }
  >();
  let skipped = 0;

  for (const r of rows) {
    const categorySlug = slugify(r.category ?? '');
    const brandSlug = slugify(r.brand ?? '');
    if (!categorySlug || !brandSlug) {
      skipped += 1;
      continue;
    }
    categories.set(categorySlug, titleCase(categorySlug));
    brands.set(brandSlug, titleCase(brandSlug));
    const subSlug = slugify(r.subcategory ?? '');
    if (subSlug) {
      const key = `${categorySlug}/${subSlug}`;
      subcategories.set(key, {
        categorySlug,
        slug: subSlug,
        name: titleCase(subSlug),
      });
      links.set(`${brandSlug}|${key}`, {
        brandSlug,
        categorySlug,
        subcategorySlug: subSlug,
      });
    }
  }

  const bySlug = (a: { slug: string }, b: { slug: string }) =>
    a.slug.localeCompare(b.slug);
  return {
    categories: [...categories]
      .map(([slug, name]) => ({ slug, name }))
      .sort(bySlug),
    subcategories: [...subcategories.values()].sort(
      (a, b) =>
        a.categorySlug.localeCompare(b.categorySlug) ||
        a.slug.localeCompare(b.slug),
    ),
    brands: [...brands].map(([slug, name]) => ({ slug, name })).sort(bySlug),
    links: [...links.values()].sort(
      (a, b) =>
        a.brandSlug.localeCompare(b.brandSlug) ||
        a.categorySlug.localeCompare(b.categorySlug) ||
        a.subcategorySlug.localeCompare(b.subcategorySlug),
    ),
    skipped,
  };
}

/** One product row from the source (column names of the import). */
export interface ProductRow {
  sku: string;
  brand: string;
  model: string | null;
  modelCode: string | null;
  category: string | null;
  subCategory: string | null;
  silhouette: string | null;
  gender: string | null;
  colour: string | null;
  size: string | null;
  msrp: number | null;
  releaseDate: string | null;
  title: string | null;
}

export interface ProductUpsert {
  sku: string;
  brandSlug: string;
  model: string | null;
  modelCode: string | null;
  category: string | null;
  subCategory: string | null;
  silhouette: string | null;
  gender: Gender | null;
  colour: string | null;
  size: string | null;
  sizeRaw: string | null;
  msrp: number | null;
  releaseDate: string | null;
  title: string | null;
}

const clip = (v: string | null | undefined, max: number): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t.slice(0, max);
};

/** Row → upsert, or null when sku or brand is unusable. Later duplicates of a
 *  sku replace earlier ones. */
export function importProducts(rows: readonly ProductRow[]): {
  products: ProductUpsert[];
  skipped: number;
} {
  const out = new Map<string, ProductUpsert>();
  let skipped = 0;
  for (const r of rows) {
    const sku = clip(r.sku, 40);
    const brandSlug = slugify(r.brand ?? '');
    if (!sku || !brandSlug) {
      skipped += 1;
      continue;
    }
    out.set(sku, {
      sku,
      brandSlug,
      model: clip(cleanModel(r.model, r.colour, r.size), 200),
      modelCode: clip(r.modelCode, 100),
      category: clip(r.category, 100),
      subCategory: clip(r.subCategory, 100),
      silhouette: clip(r.silhouette, 100),
      gender: normalizeGender(r.gender),
      colour: clip(r.colour, 200),
      size: normalizeSize(r.size),
      sizeRaw: clip(r.size, 120),
      msrp:
        r.msrp === null ||
        r.msrp === undefined ||
        !Number.isFinite(Number(r.msrp))
          ? null
          : Number(r.msrp),
      releaseDate: clip(r.releaseDate, 10),
      title: clip(r.title, 500),
    });
  }
  return { products: [...out.values()], skipped };
}

/** Distinct normalised sizes per brand, in numeric order. */
export function sizesByBrand(
  products: readonly { brandSlug: string; size: string | null }[],
): Map<string, string[]> {
  const acc = new Map<string, Set<string>>();
  for (const p of products) {
    if (!p.size) continue;
    let set = acc.get(p.brandSlug);
    if (!set) {
      set = new Set<string>();
      acc.set(p.brandSlug, set);
    }
    set.add(p.size);
  }
  return new Map([...acc].map(([k, v]) => [k, sizeOrder([...v])]));
}
