// Unit tests for the assumed ShoeDNA response mapping (analyze). The contract
// is provisional, so these pin the rules that must survive a contract change:
// source is always 'server', E10's identified/failed rule, and the
// trim-don't-fail handling of candidates and raw.
import { FALLBACK_MODEL_VERSION, mapShoeDnaResponse } from './shoedna-rules';

const OPTS: {
  maxCandidates: number;
  rawMaxBytes: number;
  versionFallback: string | null;
} = { maxCandidates: 3, rawMaxBytes: 8192, versionFallback: null };

const FULL = {
  modelVersion: 'shoedna-server-2.0.1',
  brand: 'Nike',
  subBrand: 'Jordan',
  model: 'Air Jordan 1',
  colorway: 'Chicago',
  category: 'sneaker',
  subCategory: 'basketball',
  material: 'leather',
  confidence: 0.91234,
  conditionCode: 'C2',
  candidates: [
    { brand: 'Adidas', model: 'Forum', confidence: 0.03 },
    { brand: 'Nike', model: 'Air Jordan 1', confidence: 0.91234 },
  ],
};

function ok(body: unknown, opts = OPTS) {
  const r = mapShoeDnaResponse(body, opts);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r;
}

describe('mapShoeDnaResponse', () => {
  it('maps a full answer to an identified, server-sourced result', () => {
    const { fields, rawDropped } = ok(FULL);
    expect(fields).toMatchObject({
      source: 'server',
      outcome: 'identified',
      modelVersion: 'shoedna-server-2.0.1',
      brand: 'Nike',
      subBrand: 'Jordan',
      model: 'Air Jordan 1',
      category: 'sneaker',
      material: 'leather',
      confidence: 0.91234,
      conditionCode: 'C2',
    });
    // E10's canonical order: confidence desc, rounded to 4 dp.
    expect(fields.candidates).toEqual([
      { brand: 'Nike', model: 'Air Jordan 1', confidence: 0.9123 },
      { brand: 'Adidas', model: 'Forum', confidence: 0.03 },
    ]);
    expect(fields.raw).toBe(FULL);
    expect(rawDropped).toBe(false);
  });

  it('is failed when brand or confidence is missing (E10 RESULT_INCOMPLETE rule)', () => {
    expect(ok({ ...FULL, brand: null }).fields.outcome).toBe('failed');
    expect(ok({ ...FULL, confidence: undefined }).fields.outcome).toBe(
      'failed',
    );
    expect(ok({ ...FULL, brand: '   ' }).fields.outcome).toBe('failed');
  });

  it("honours an explicit outcome 'failed' from the model", () => {
    expect(ok({ ...FULL, outcome: 'failed' }).fields.outcome).toBe('failed');
  });

  it('maps an empty object to a failed result with no fields', () => {
    const { fields } = ok({});
    expect(fields.outcome).toBe('failed');
    expect(fields.brand).toBeNull();
    expect(fields.candidates).toEqual([]);
  });

  it('keeps only the top distinct candidates instead of failing', () => {
    const { fields } = ok({
      ...FULL,
      candidates: [
        { brand: 'A', confidence: 0.1 },
        { brand: 'B', confidence: 0.5 },
        { brand: 'b', confidence: 0.4 }, // duplicate of B (case-insensitive)
        { brand: 'C', confidence: 0.3 },
        { brand: 'D', confidence: 0.2 },
      ],
    });
    expect(fields.candidates.map((c) => c.brand)).toEqual(['B', 'C', 'D']);
  });

  it.each([
    ['a non-object body', 'nope'],
    ['an array body', []],
    ['null', null],
    ['a non-string brand', { ...FULL, brand: 42 }],
    ['an over-long model', { ...FULL, model: 'x'.repeat(161) }],
    ['confidence above 1', { ...FULL, confidence: 1.2 }],
    ['an unknown condition code', { ...FULL, conditionCode: 'C9' }],
    ['candidates not an array', { ...FULL, candidates: {} }],
    [
      'a candidate without brand',
      { ...FULL, candidates: [{ confidence: 0.2 }] },
    ],
    [
      'a candidate confidence out of range',
      { ...FULL, candidates: [{ brand: 'A', confidence: -0.1 }] },
    ],
  ])('rejects %s', (_label, body) => {
    expect(mapShoeDnaResponse(body, OPTS).ok).toBe(false);
  });

  it('drops an oversized raw body but still stores the result', () => {
    const r = ok(
      { ...FULL, debug: 'x'.repeat(500) },
      { ...OPTS, rawMaxBytes: 200 },
    );
    expect(r.rawDropped).toBe(true);
    expect(r.fields.raw).toBeNull();
    expect(r.fields.brand).toBe('Nike');
  });

  it('falls back to the integration version, then a fixed label', () => {
    expect(
      ok(
        { ...FULL, modelVersion: 'bad version!' },
        { ...OPTS, versionFallback: 'v2.1' },
      ).fields.modelVersion,
    ).toBe('v2.1');
    expect(ok({ ...FULL, modelVersion: undefined }).fields.modelVersion).toBe(
      FALLBACK_MODEL_VERSION,
    );
  });
});
