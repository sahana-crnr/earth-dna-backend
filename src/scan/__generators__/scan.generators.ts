// Domain generators for the F1 property tests (PBT-07). Shaped like real
// input: subsets of the four views in any order with repeats, realistic file
// headers, manifests with the mistakes an app can actually make.
import fc from 'fast-check';
import { SHOE_VIEWS, type ShoeView } from '../scan.types';
import type { AlbumFileInfo, AlbumManifestShoe } from '../scan-rules';
import type { PhotoType } from '../../config/scan.config';

export const viewArb: fc.Arbitrary<ShoeView> = fc.constantFrom(...SHOE_VIEWS);

/** Captured views for one shoe: any multiset of views (duplicates allowed). */
export const viewsArb = fc.array(viewArb, { maxLength: 8 });

/** A shoe as the rules see it. */
export const shoeViewsArb = fc.record({
  id: fc.uuid(),
  position: fc.integer({ min: 1, max: 99 }),
  views: viewsArb,
});

export const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
export const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Image-like byte arrays: real JPEG/PNG headers or arbitrary junk. */
export const bytesArb = fc.oneof(
  fc
    .uint8Array({ maxLength: 64 })
    .map((t) => Uint8Array.from([...JPEG_HEAD, ...t])),
  fc
    .uint8Array({ maxLength: 64 })
    .map((t) => Uint8Array.from([...PNG_HEAD, ...t])),
  fc.uint8Array({ maxLength: 64 }),
);

export const photoTypeArb: fc.Arbitrary<PhotoType | null> = fc.constantFrom(
  'jpeg',
  'png',
  null,
);

const fieldArb = fc.constantFrom(
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
);

/** View names the app might send, including invalid ones. */
const manifestViewArb = fc.oneof(
  { weight: 9, arbitrary: viewArb },
  { weight: 1, arbitrary: fc.constantFrom('front', 'back', '') },
);

export const manifestShoeArb: fc.Arbitrary<AlbumManifestShoe> = fc.record({
  ref: fc.stringMatching(/^[a-z]{1,3}$/),
  files: fc.array(fc.record({ field: fieldArb, view: manifestViewArb }), {
    maxLength: 4,
  }),
});

export const manifestArb = fc.array(manifestShoeArb, { maxLength: 4 });

/** File parts keyed by field; some fields missing, sizes around the limit. */
export const filesArb = (maxBytes: number) =>
  fc
    .array(
      fc.tuple(
        fieldArb,
        fc.record({
          size: fc.oneof(
            fc.integer({ min: 1, max: maxBytes }),
            fc.integer({ min: maxBytes + 1, max: maxBytes * 2 }),
            fc.constant(0),
          ),
          type: photoTypeArb,
        }),
      ),
      { maxLength: 8 },
    )
    .map((pairs) => new Map<string, AlbumFileInfo>(pairs));
