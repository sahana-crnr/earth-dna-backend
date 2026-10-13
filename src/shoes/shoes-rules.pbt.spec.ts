// Property-based tests for the pure F4 + F6 rules (shoes-rules.ts).
import fc from 'fast-check';
import { conditionLabelFor } from '../scan/result-rules';
import { CONDITION_CODES } from '../scan/scan.types';
import { conditionCodeArb } from '../scan/__generators__/result.generators';
import {
  CONDITION_FILTERS,
  CONDITION_FILTER_CODES,
  codesForConditions,
  conditionSlug,
  splitMulti,
  toSummary,
  type SummaryAggregate,
} from './shoes-rules';

describe('F4-P1 condition filter', () => {
  it('is the F2 label scale, slugged', () => {
    expect(CONDITION_FILTERS).toEqual([
      'like_new',
      'lightly_worn',
      'heavily_worn',
      'not_wearable',
    ]);
    expect(CONDITION_FILTER_CODES.heavily_worn).toEqual(['C3', 'C4']);
  });

  it('a code is matched by the slug of the label the card shows for it', () => {
    fc.assert(
      fc.property(conditionCodeArb, (code) => {
        const slug = conditionSlug(conditionLabelFor(code)!);
        expect(codesForConditions([slug])).toContain(code);
      }),
    );
  });

  it('slugs partition the codes: every code under exactly one slug', () => {
    const all = Object.values(CONDITION_FILTER_CODES).flat();
    expect([...all].sort()).toEqual([...CONDITION_CODES].sort());
  });

  it('is a union, order-independent, and ignores unknown slugs', () => {
    const slugArb = fc.constantFrom(...CONDITION_FILTERS, 'nope', '');
    fc.assert(
      fc.property(fc.array(slugArb, { maxLength: 8 }), (slugs) => {
        const got = codesForConditions(slugs);
        const want = new Set(
          slugs.flatMap((s) => CONDITION_FILTER_CODES[s] ?? []),
        );
        expect(new Set(got)).toEqual(want);
        expect(got).toEqual(codesForConditions([...slugs].reverse()));
        expect(new Set(got).size).toBe(got.length);
      }),
    );
  });
});

describe('F4-P2 splitMulti', () => {
  const token = fc.stringMatching(/^[a-z_]{1,6}$/);

  it('comma-joined, repeated and mixed forms mean the same set', () => {
    fc.assert(
      fc.property(fc.array(token, { minLength: 1, maxLength: 6 }), (xs) => {
        const want = [...new Set(xs)];
        expect(splitMulti(xs.join(','))).toEqual(want);
        expect(splitMulti(xs)).toEqual(want);
        const half = Math.ceil(xs.length / 2);
        expect(
          splitMulti([xs.slice(0, half).join(','), ...xs.slice(half)]),
        ).toEqual(want);
      }),
    );
  });

  it('drops empty pieces and passes non-strings through untouched', () => {
    expect(splitMulti(' a, ,b,,a ')).toEqual(['a', 'b']);
    expect(splitMulti(undefined)).toBeUndefined();
    const obj = { a: 1 };
    expect(splitMulti(obj)).toBe(obj);
    expect(splitMulti([1, 'a'])).toEqual([1, 'a']);
  });
});

describe('F6-P1 toSummary', () => {
  const amount = fc.integer({ min: 0, max: 10_000_000 }).map((c) => c / 100);
  const pgNum = (n: number) => fc.constantFrom<string | number>(String(n), n);
  const aggArb: fc.Arbitrary<SummaryAggregate> = fc
    .record({
      pairs: fc.nat({ max: 1000 }),
      valueCount: fc.nat({ max: 1000 }),
      valueMin: amount,
      valueMax: amount,
    })
    .chain((r) =>
      fc.record({
        pairs: pgNum(r.pairs),
        valueCount: pgNum(r.valueCount),
        valueMin: r.valueCount ? pgNum(r.valueMin) : fc.constant(null),
        valueMax: r.valueCount ? pgNum(r.valueMax) : fc.constant(null),
      }),
    );

  it('null exactly when nothing carries the value; sums pass through', () => {
    fc.assert(
      fc.property(aggArb, (agg) => {
        const s = toSummary(agg);
        expect(s.pairsScanned).toBe(Number(agg.pairs));
        if (Number(agg.valueCount) === 0) expect(s.potentialValue).toBeNull();
        else
          expect(s.potentialValue).toEqual({
            min: Number(agg.valueMin),
            max: Number(agg.valueMax),
            currency: 'USD',
          });
      }),
    );
  });

  it('never reports a negative or non-finite total', () => {
    expect(
      toSummary({
        pairs: null,
        valueCount: '1',
        valueMin: 'garbage',
        valueMax: '12.345',
      }),
    ).toEqual({
      pairsScanned: 0,
      potentialValue: { min: 0, max: 12.35, currency: 'USD' },
    });
  });
});
