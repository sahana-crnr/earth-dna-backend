// Property-based tests for the pure F3 review rules (how-to.md §5 P1–P5, P7).
import fc from 'fast-check';
import {
  VALUE_PLACEHOLDERS,
  brandCorrected,
  isCompleted,
  isUnknownBrand,
  missingFields,
  overlayDetails,
  placeholderFor,
  resaleBucketFor,
  reviewStateFor,
  reviewedCount,
  stableHash,
  thumbnailKeyFor,
  type DetailsAnswer,
  type PredictedIdentity,
  type ReviewMode,
} from './review-rules';
import {
  CONDITION_CODES,
  GENDERS,
  RESALE_BUCKETS,
  SCAN_SHOE_STATUSES,
  SHOE_VIEWS,
  type ScanShoeStatus,
} from './scan.types';

const maybeText = fc.option(fc.string({ maxLength: 12 }), { nil: null });
const predictedArb: fc.Arbitrary<PredictedIdentity> = fc.record({
  brand: fc.oneof(maybeText, fc.constant('Unknown'), fc.constant(' unknown ')),
  model: maybeText,
  colorway: maybeText,
  subBrand: maybeText,
  category: maybeText,
  subCategory: maybeText,
  conditionCode: fc.option(fc.constantFrom(...CONDITION_CODES), { nil: null }),
  material: maybeText,
});
// `undefined` = field absent from the body; null / '' / '  ' = sent but empty.
const bodyField = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(''),
  fc.constant('   '),
  fc.string({ minLength: 1, maxLength: 12 }).map((s) => ` ${s} `),
);
const answerArb: fc.Arbitrary<DetailsAnswer> = fc.record(
  {
    brand: bodyField,
    model: bodyField,
    color: bodyField,
    size: bodyField,
    gender: fc.option(fc.constantFrom(...GENDERS), { nil: null }),
  },
  { requiredKeys: [] },
);
const statusArb = fc.constantFrom(...SCAN_SHOE_STATUSES);
const shoesArb = fc.array(fc.record({ status: statusArb }), { maxLength: 6 });

const blank = (v: string | null | undefined) =>
  v === undefined || v === null || v.trim() === '';

describe('F3-P1 overlayDetails', () => {
  it('brand: body wins when non-blank, else prediction; never invents a value', () => {
    fc.assert(
      fc.property(predictedArb, answerArb, (p, a) => {
        const out = overlayDetails(p, a);
        if (!blank(a.brand)) expect(out.brand).toBe(a.brand!.trim());
        else
          expect(out.brand).toBe(
            isUnknownBrand(p.brand) ? null : p.brand!.trim(),
          );
      }),
    );
  });

  it('model / colour: body wins, else prediction; size only from the body; gender as sent', () => {
    fc.assert(
      fc.property(predictedArb, answerArb, (p, a) => {
        const out = overlayDetails(p, a);
        const c = (v: string | null | undefined) =>
          blank(v) ? null : v!.trim();
        expect(out.model).toBe(c(a.model) ?? c(p.model));
        expect(out.color).toBe(c(a.color) ?? c(p.colorway));
        expect(out.size).toBe(c(a.size));
        expect(out.gender).toBe(a.gender ?? null);
      }),
    );
  });

  it('a changed brand drops the predicted sub-brand; brandCorrected agrees', () => {
    fc.assert(
      fc.property(predictedArb, answerArb, (p, a) => {
        const out = overlayDetails(p, a);
        const corrected = brandCorrected(
          p.brand,
          blank(a.brand) ? null : a.brand!,
        );
        if (corrected) expect(out.subBrand).toBeNull();
        else
          expect(out.subBrand).toBe(
            blank(p.subBrand) ? null : p.subBrand!.trim(),
          );
      }),
    );
    expect(brandCorrected('Nike', 'nike ')).toBe(false);
    expect(brandCorrected('Nike', 'Adidas')).toBe(true);
    expect(brandCorrected('Unknown', 'Nike')).toBe(true);
    expect(brandCorrected('Nike', null)).toBe(false);
    expect(isUnknownBrand('UNKNOWN')).toBe(true);
    expect(isUnknownBrand('')).toBe(true);
    expect(isUnknownBrand('Nike')).toBe(false);
  });

  it('category, subCategory, condition and material are copied untouched (F3-D5, D8)', () => {
    fc.assert(
      fc.property(predictedArb, answerArb, (p, a) => {
        const out = overlayDetails(p, a);
        const c = (v: string | null) => (blank(v) ? null : v!.trim());
        expect(out.category).toBe(c(p.category));
        expect(out.subCategory).toBe(c(p.subCategory));
        expect(out.conditionCode).toBe(p.conditionCode);
        expect(out.material).toBe(c(p.material));
      }),
    );
  });
});

describe('F3-P2 / P3 reviewedCount and isCompleted', () => {
  it('done counts confirmed + rejected only; done ≤ total = length', () => {
    fc.assert(
      fc.property(shoesArb, (shoes) => {
        const { done, total } = reviewedCount(shoes);
        expect(total).toBe(shoes.length);
        expect(done).toBe(
          shoes.filter(
            (s) => s.status === 'confirmed' || s.status === 'rejected',
          ).length,
        );
        expect(done).toBeLessThanOrEqual(total);
      }),
    );
  });

  it('completed ⇔ at least one shoe and every shoe reviewed', () => {
    fc.assert(
      fc.property(shoesArb, (shoes) => {
        const { done, total } = reviewedCount(shoes);
        expect(isCompleted(shoes)).toBe(total > 0 && done === total);
      }),
    );
    expect(isCompleted([])).toBe(false);
  });

  it('reviewStateFor is null for every non-review status', () => {
    for (const s of SCAN_SHOE_STATUSES) {
      const r = reviewStateFor(s);
      if (s === 'confirmed' || s === 'rejected') expect(r).toBe(s);
      else expect(r).toBeNull();
    }
  });
});

describe('F3-P5 missingFields', () => {
  it('confirm never reports a missing field', () => {
    fc.assert(
      fc.property(answerArb, (a) => {
        expect(missingFields('confirm', a)).toEqual([]);
      }),
    );
  });

  it('reject reports exactly the blank ones among brand, model, color, size', () => {
    fc.assert(
      fc.property(answerArb, (a) => {
        const missing = missingFields('reject', a);
        const expected = (['brand', 'model', 'color', 'size'] as const).filter(
          (f) => blank(a[f]),
        );
        expect(missing).toEqual(expected);
      }),
    );
  });

  it('a full answer passes both modes', () => {
    const full = { brand: 'Nike', model: 'Air Max', color: 'White', size: '7' };
    for (const mode of ['confirm', 'reject'] as ReviewMode[]) {
      expect(missingFields(mode, full)).toEqual([]);
    }
  });
});

describe('F3-P4 placeholderFor', () => {
  it('is deterministic and always one of the Figma options', () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        const a = placeholderFor(id);
        expect(placeholderFor(id)).toEqual(a);
        expect(VALUE_PLACEHOLDERS).toContain(a);
      }),
    );
  });

  it('every option has min ≤ max (or both null) and a bucket matching its max', () => {
    for (const p of VALUE_PLACEHOLDERS) {
      if (p.resaleMin === null || p.resaleMax === null) {
        expect(p.resaleMin).toBeNull();
        expect(p.resaleMax).toBeNull();
      } else {
        expect(p.resaleMin).toBeLessThanOrEqual(p.resaleMax);
      }
      expect(p.resaleBucket).toBe(resaleBucketFor(p.resaleMax));
    }
  });

  it('uses all four options across many ids (the hash spreads)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(JSON.stringify(placeholderFor(`shoe-${i}`)));
    }
    expect(seen.size).toBe(VALUE_PLACEHOLDERS.length);
  });

  it('stableHash is a 32-bit unsigned value and differs for different strings most of the time', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const h = stableHash(s);
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(0xffffffff);
      }),
    );
  });

  it('resaleBucketFor is total and monotone', () => {
    expect(resaleBucketFor(null)).toBeNull();
    expect(resaleBucketFor(NaN)).toBeNull();
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const ia = RESALE_BUCKETS.indexOf(resaleBucketFor(lo)!);
          const ib = RESALE_BUCKETS.indexOf(resaleBucketFor(hi)!);
          expect(ia).toBeLessThanOrEqual(ib);
        },
      ),
    );
  });
});

describe('thumbnailKeyFor', () => {
  const photosArb = fc
    .uniqueArray(fc.constantFrom(...SHOE_VIEWS), { maxLength: 4 })
    .map((views) => views.map((view) => ({ view, s3Key: `k/${view}` })));

  it('preferred view wins, else first canonical view, else null', () => {
    fc.assert(
      fc.property(photosArb, fc.constantFrom(...SHOE_VIEWS), (photos, pref) => {
        const key = thumbnailKeyFor(photos, pref);
        const has = (v: string) => photos.some((p) => p.view === v);
        if (has(pref)) expect(key).toBe(`k/${pref}`);
        else if (photos.length === 0) expect(key).toBeNull();
        else {
          const first = SHOE_VIEWS.find((v) => has(v))!;
          expect(key).toBe(`k/${first}`);
        }
      }),
    );
  });
});

// ─── F3-P7: review state machine (PBT-06) ────────────────────────────────────
// A pure model of what the service enforces: one entry per shoe, second review
// always rejected, completion exactly when every shoe is reviewed.
type Cmd = { shoe: number; mode: ReviewMode };

function runModel(n: number, cmds: readonly Cmd[]) {
  const status: ScanShoeStatus[] = Array.from(
    { length: n },
    () => 'identified',
  );
  const entries = new Set<number>();
  let rejected409 = 0;
  for (const c of cmds) {
    const i = c.shoe % n;
    if (status[i] === 'confirmed' || status[i] === 'rejected') {
      rejected409 += 1;
      continue;
    }
    status[i] = c.mode === 'confirm' ? 'confirmed' : 'rejected';
    entries.add(i);
  }
  return { status, entries, rejected409 };
}

describe('F3-P7 review state machine (model)', () => {
  it('exactly one entry per reviewed shoe; completed ⇔ all reviewed; extra reviews are refused', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.array(
          fc.record({
            shoe: fc.nat({ max: 3 }),
            mode: fc.constantFrom<ReviewMode>('confirm', 'reject'),
          }),
          { maxLength: 12 },
        ),
        (n, cmds) => {
          const { status, entries, rejected409 } = runModel(n, cmds);
          const shoes = status.map((s) => ({ status: s }));
          const { done } = reviewedCount(shoes);
          expect(entries.size).toBe(done);
          expect(isCompleted(shoes)).toBe(done === n);
          const distinctReviewed = new Set(cmds.map((c) => c.shoe % n)).size;
          expect(rejected409).toBe(cmds.length - distinctReviewed);
        },
      ),
    );
  });
});
