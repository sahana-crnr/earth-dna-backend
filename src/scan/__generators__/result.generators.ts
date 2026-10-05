// Domain generators for the F2 property tests. Shaped like real ShoeDNA output,
// and deliberately including the mistakes a client can actually make: brands
// drawn from a small pool so duplicates really occur, confidences that stray
// outside [0,1], and blobs that are too big or too deeply nested.
import fc from 'fast-check';
import {
  CONDITION_CODES,
  IDENTIFICATION_OUTCOMES,
  SCAN_SHOE_STATUSES,
  type ConditionCode,
  type IdentificationOutcome,
  type ScanShoeStatus,
} from '../scan.types';

export const conditionCodeArb: fc.Arbitrary<ConditionCode> = fc.constantFrom(
  ...CONDITION_CODES,
);

export const outcomeArb: fc.Arbitrary<IdentificationOutcome> = fc.constantFrom(
  ...IDENTIFICATION_OUTCOMES,
);

export const shoeStatusArb: fc.Arbitrary<ScanShoeStatus> = fc.constantFrom(
  ...SCAN_SHOE_STATUSES,
);

/** In-range confidences only. */
export const confidenceArb = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Confidences a client might send, valid or not. */
export const anyConfidenceArb = fc.oneof(
  { weight: 8, arbitrary: confidenceArb },
  { weight: 1, arbitrary: fc.double({ min: -5, max: -0.0001, noNaN: true }) },
  { weight: 1, arbitrary: fc.double({ min: 1.0001, max: 5, noNaN: true }) },
);

/** Small pool, so duplicate brand+model pairs are generated often. */
const brandArb = fc.constantFrom('Nike', 'Adidas', 'nike ', 'Puma', 'ASICS');
const modelArb = fc.oneof(
  fc.constantFrom('Air Max 90', 'Gazelle', 'Air Max 95'),
  fc.constant(undefined),
);

export const candidateArb = fc.record({
  brand: brandArb,
  model: modelArb,
  confidence: confidenceArb,
});

export const candidatesArb = fc.array(candidateArb, { maxLength: 6 });

/** Same, but confidences may be out of range. */
export const loseCandidatesArb = fc.array(
  fc.record({
    brand: brandArb,
    model: modelArb,
    confidence: anyConfidenceArb,
  }),
  { maxLength: 6 },
);

/** Free-form ShoeDNA passthrough blobs, shallow enough not to trip the depth cap. */
export const rawBlobArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  ),
  { maxKeys: 8 },
);

/** Nests `depth` levels of single-key objects: { a: { a: { … } } }. */
export function nestedBlob(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: 1 };
  for (let i = 1; i < depth; i += 1) node = { a: node };
  return node;
}
