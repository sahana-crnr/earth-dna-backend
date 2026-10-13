// Pure F4 + F6 rules (Backend API Plan §4, "F4 + F6"). No Nest, TypeORM or AWS
// imports, so everything here is property-tested directly.
import { CONDITION_LABELS } from '../scan/result-rules';
import { CONDITION_CODES, type ConditionCode } from '../scan/scan.types';
import type { ShoeSummaryView } from './shoes.view';

// ─── F4-P1: condition filter ─────────────────────────────────────────────────

/** "Heavily Worn" → "heavily_worn". */
export function conditionSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The `?condition=` values are the F2 labels the cards show, slugged — derived
 * from CONDITION_LABELS rather than listed, so confirming the PROVISIONAL scale
 * (plan open point 7) is still one map edit and the filter cannot drift from
 * the label on the card. Several codes may share a label (C3/C4 today), so a
 * slug filters on every code behind it.
 */
export const CONDITION_FILTER_CODES: Readonly<
  Record<string, readonly ConditionCode[]>
> = CONDITION_CODES.reduce<Record<string, ConditionCode[]>>((acc, code) => {
  const slug = conditionSlug(CONDITION_LABELS[code]);
  (acc[slug] ??= []).push(code);
  return acc;
}, {});

/** In label order: like_new, lightly_worn, heavily_worn, not_wearable. */
export const CONDITION_FILTERS: readonly string[] = Object.keys(
  CONDITION_FILTER_CODES,
);

/** Unknown slugs contribute nothing (the DTO has already rejected them). */
export function codesForConditions(slugs: readonly string[]): ConditionCode[] {
  const out = new Set<ConditionCode>();
  for (const s of slugs) {
    for (const c of CONDITION_FILTER_CODES[s] ?? []) out.add(c);
  }
  return CONDITION_CODES.filter((c) => out.has(c));
}

// ─── F4-P2: multi-value query params ─────────────────────────────────────────

/**
 * `?x=a,b`, `?x=a&x=b` and `?x=a,b&x=c` all mean [a, b, c]. Empty pieces are
 * dropped and duplicates collapsed, so `?x=a,,a` is just [a]. Anything that is
 * not a string is passed through for the validator to reject.
 */
export function splitMulti(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const parts = Array.isArray(value) ? value : [value];
  if (!parts.every((p) => typeof p === 'string')) return value;
  const out = parts
    .flatMap((p) => p.split(','))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return [...new Set(out)];
}

// ─── F6-P1: summary (CO2e dropped 2026-10-09, F3.1) ─────────────────────────

/** The one aggregate row E21 reads. Postgres returns numeric sums and bigint
 *  counts as strings, hence the unions. */
export interface SummaryAggregate {
  pairs: string | number | null;
  valueCount: string | number | null;
  valueMin: string | number | null;
  valueMax: string | number | null;
}

function num(v: string | number | null): number {
  if (v === null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Cents-exact: sums of numeric(10,2) never pick up float noise in JSON. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Plan §5 decision 9: totals are sums of per-shoe values, `null` when no shoe
 * carries one — "nothing to sum" is not "worth 0". Currency is fixed to USD:
 * it is the only one written today (column default), and summing across
 * currencies would be wrong rather than merely imprecise.
 */
export function toSummary(agg: SummaryAggregate): ShoeSummaryView {
  const valueCount = num(agg.valueCount);
  return {
    pairsScanned: num(agg.pairs),
    potentialValue:
      valueCount > 0
        ? {
            min: round2(num(agg.valueMin)),
            max: round2(num(agg.valueMax)),
            currency: 'USD',
          }
        : null,
  };
}
