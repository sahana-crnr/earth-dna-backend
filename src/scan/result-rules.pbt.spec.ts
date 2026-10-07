// Property-based tests for the pure F2 rules, with the pinned examples that
// carry the actual contract (same shape as scan-rules.pbt.spec.ts). Shrinking
// is on; fast-check prints a replayable seed for any failure.
import fc from 'fast-check';
import {
  CONDITION_LABELS,
  checkRawPayload,
  conditionLabelFor,
  isConditionCode,
  matchPercent,
  normalizeCandidates,
  resultStatusFor,
  roundConfidence,
} from './result-rules';
import {
  CONDITION_CODES,
  IDENTIFICATION_OUTCOMES,
  RESULT_STATUSES,
} from './scan.types';
import {
  candidatesArb,
  conditionCodeArb,
  confidenceArb,
  loseCandidatesArb,
  nestedBlob,
  outcomeArb,
  rawBlobArb,
} from './__generators__/result.generators';

describe('F2-P1 conditionLabelFor', () => {
  it('is total over CONDITION_CODES: always a non-empty label, never throws', () => {
    fc.assert(
      fc.property(conditionCodeArb, (code) => {
        const label = conditionLabelFor(code);
        expect(typeof label).toBe('string');
        expect(label).not.toHaveLength(0);
      }),
    );
  });

  it('null in, null out', () => {
    expect(conditionLabelFor(null)).toBeNull();
  });

  it('maps the provisional scale (plan §8, open point 7)', () => {
    expect(CONDITION_CODES.map((c) => conditionLabelFor(c))).toEqual([
      'Like New',
      'Lightly Worn',
      'Heavily Worn',
      'Heavily Worn',
      'Not wearable',
    ]);
    // Five codes, four labels — C3 and C4 share one until design confirms.
    expect(new Set(Object.values(CONDITION_LABELS)).size).toBe(4);
  });

  it('isConditionCode rejects anything not in the enum', () => {
    expect(CONDITION_CODES.every(isConditionCode)).toBe(true);
    for (const v of ['c1', 'C6', '', 'C', 1, null, undefined]) {
      expect(isConditionCode(v)).toBe(false);
    }
  });
});

describe('F2-P2 matchPercent', () => {
  it('is Math.round(confidence * 100) and always within 0..100', () => {
    fc.assert(
      fc.property(confidenceArb, (c) => {
        const pct = matchPercent(c)!;
        expect(pct).toBe(Math.round(c * 100));
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
      }),
    );
  });

  it('rounds the way the Review Matches screen expects', () => {
    expect(matchPercent(0.9234)).toBe(92);
    expect(matchPercent(0.995)).toBe(100);
    expect(matchPercent(0)).toBe(0);
    expect(matchPercent(1)).toBe(100);
    expect(matchPercent(null)).toBeNull();
    expect(matchPercent(Number.NaN)).toBeNull();
  });

  it('clamps values the DB CHECK would have rejected', () => {
    expect(matchPercent(-1)).toBe(0);
    expect(matchPercent(5)).toBe(100);
  });
});

describe('F2-P3 resultStatusFor', () => {
  it('is total over outcome, and a stored outcome always wins', () => {
    fc.assert(
      fc.property(fc.option(outcomeArb, { nil: null }), (outcome) => {
        const status = resultStatusFor(outcome);
        expect(RESULT_STATUSES).toContain(status);
        if (outcome !== null) expect(status).toBe(outcome);
      }),
    );
  });

  // The shoe row is deliberately not consulted: identification runs on the
  // device, so `waiting` is the only thing the server can say until a result
  // lands, and after F3 the row reads confirmed/rejected regardless.
  it('reports waiting until a result arrives', () => {
    expect(resultStatusFor(null)).toBe('waiting');
    expect(resultStatusFor('identified')).toBe('identified');
    expect(resultStatusFor('failed')).toBe('failed');
  });

  it('every outcome maps to a known result status', () => {
    for (const o of [null, ...IDENTIFICATION_OUTCOMES] as const) {
      expect(RESULT_STATUSES).toContain(resultStatusFor(o));
    }
  });
});

describe('F2-P4 normalizeCandidates', () => {
  const MAX = 3;

  it('accepted output is sorted by confidence desc and keeps every input entry', () => {
    fc.assert(
      fc.property(candidatesArb, (raw) => {
        const d = normalizeCandidates(raw, MAX);
        if (!d.ok) return;
        expect(d.candidates).toHaveLength(raw.length);
        const confs = d.candidates.map((c) => c.confidence);
        expect([...confs].sort((a, b) => b - a)).toEqual(confs);
        // nothing invented: same multiset of confidences, at stored precision
        expect([...confs].sort()).toEqual(
          raw.map((c) => roundConfidence(c.confidence)).sort(),
        );
      }),
    );
  });

  // The column is numeric(5,4) but candidates live in jsonb, which would
  // otherwise keep every digit the client sent — one response, two precisions.
  it('stores candidate confidences at the precision of the confidence column', () => {
    const d = normalizeCandidates(
      [{ brand: 'Nike', model: 'Air Max 90', confidence: 0.92345678 }],
      MAX,
    );
    expect(d.ok && d.candidates[0].confidence).toBe(0.9235);
  });

  it('never rounds a valid confidence out of range', () => {
    fc.assert(
      fc.property(confidenceArb, (c) => {
        const r = roundConfidence(c);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('depends only on the SET of candidates, never on the order sent', () => {
    fc.assert(
      fc.property(candidatesArb, fc.nat(), (raw, rot) => {
        const n = raw.length;
        if (n === 0) return;
        const shift = rot % n;
        const rotated = [...raw.slice(shift), ...raw.slice(0, shift)];
        const a = normalizeCandidates(raw, MAX);
        const b = normalizeCandidates(rotated, MAX);
        expect(a.ok).toBe(b.ok);
        if (a.ok && b.ok) expect(a.candidates).toEqual(b.candidates);
      }),
    );
  });

  it('accepts exactly when short enough, in range and free of duplicates', () => {
    fc.assert(
      fc.property(loseCandidatesArb, (raw) => {
        const keys = raw.map(
          (c) =>
            `${c.brand.trim().toLowerCase()}|${(c.model ?? '').trim().toLowerCase()}`,
        );
        const oracle =
          raw.length <= MAX &&
          raw.every((c) => c.confidence >= 0 && c.confidence <= 1) &&
          new Set(keys).size === keys.length;
        expect(normalizeCandidates(raw, MAX).ok).toBe(oracle);
      }),
    );
  });

  it('rejects rather than truncates an over-long list', () => {
    const four = [1, 2, 3, 4].map((i) => ({
      brand: `B${i}`,
      confidence: 0.1 * i,
    }));
    const d = normalizeCandidates(four, 3);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toBe('TOO_MANY_CANDIDATES');
  });

  it('treats brand+model as case- and whitespace-insensitive', () => {
    const d = normalizeCandidates(
      [
        { brand: 'Nike', model: 'Air Max 90', confidence: 0.9 },
        { brand: ' nike ', model: 'AIR MAX 90', confidence: 0.1 },
      ],
      3,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toBe('DUPLICATE_CANDIDATE');
  });

  it('rejects a confidence outside 0..1', () => {
    const d = normalizeCandidates([{ brand: 'Nike', confidence: 1.5 }], 3);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toBe('CONFIDENCE_OUT_OF_RANGE');
  });

  it('normalises a missing model to null', () => {
    const d = normalizeCandidates([{ brand: 'Nike', confidence: 0.5 }], 3);
    expect(d.ok && d.candidates).toEqual([
      { brand: 'Nike', model: null, confidence: 0.5 },
    ]);
  });
});

describe('F2-P5 checkRawPayload', () => {
  it('accepts a shallow blob exactly when it serialises within the cap', () => {
    fc.assert(
      fc.property(rawBlobArb, fc.integer({ min: 1, max: 400 }), (raw, max) => {
        const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
        expect(checkRawPayload(raw, max, 32)).toBe(
          bytes > max ? 'RAW_TOO_LARGE' : null,
        );
      }),
    );
  });

  it('passes an absent blob through', () => {
    expect(checkRawPayload(undefined, 10)).toBeNull();
    expect(checkRawPayload(null, 10)).toBeNull();
  });

  it('rejects nesting past the cap, and reports depth before size', () => {
    expect(checkRawPayload(nestedBlob(6), 1_000_000, 6)).toBeNull();
    expect(checkRawPayload(nestedBlob(7), 1_000_000, 6)).toBe('RAW_TOO_DEEP');
    // too deep AND too large -> depth, so the message names the real problem
    expect(checkRawPayload(nestedBlob(20), 1, 6)).toBe('RAW_TOO_DEEP');
  });

  it('counts arrays as nesting too', () => {
    expect(checkRawPayload([[[[1]]]], 1_000_000, 3)).toBe('RAW_TOO_DEEP');
    expect(checkRawPayload([[1]], 1_000_000, 3)).toBeNull();
  });
});
