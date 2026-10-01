// Property-based tests for the pure F1 rules (how-to.md §6, P1–P6).
// They complement the example-based checks (PBT-10). Shrinking on; fast-check
// prints the seed and path of any failure so it can be replayed (PBT-08).
import fc from 'fast-check';
import {
  canFinish,
  checkPhoto,
  computeShoeState,
  decideAlbumShoes,
  incompleteShoes,
  labelFor,
  orderByPosition,
  positionFromLabel,
  renumber,
  scanPhotoKey,
  sniffImageType,
} from './scan-rules';
import { SHOE_VIEWS } from './scan.types';
import { parsePhotoTypes } from '../config/scan.config';
import {
  bytesArb,
  filesArb,
  JPEG_HEAD,
  manifestArb,
  PNG_HEAD,
  shoeViewsArb,
  viewArb,
  viewsArb,
} from './__generators__/scan.generators';

const LIMITS = { photoMaxBytes: 1000, allowedTypes: ['jpeg', 'png'] as const };

describe('P1 computeShoeState', () => {
  it('complete ⇔ all four distinct views present; missing = the rest, in canonical order', () => {
    fc.assert(
      fc.property(viewsArb, (views) => {
        const state = computeShoeState(views);
        const distinct = new Set(views);
        expect(state.complete).toBe(distinct.size === 4);
        expect(state.missing).toEqual(
          SHOE_VIEWS.filter((v) => !distinct.has(v)),
        );
      }),
    );
  });

  it('is independent of order and duplicates (invariant)', () => {
    fc.assert(
      fc.property(
        viewsArb,
        fc.array(viewArb, { maxLength: 4 }),
        (views, extra) => {
          const once = computeShoeState(views);
          const shuffled = computeShoeState([...views].reverse());
          const withDupes = computeShoeState([
            ...views,
            ...views.filter((v) => extra.includes(v)),
          ]);
          expect(shuffled).toEqual(once);
          expect(withDupes).toEqual(once);
        },
      ),
    );
  });
});

describe('P2 labels round-trip', () => {
  it('positionFromLabel(labelFor(n)) = n', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999 }), (n) => {
        expect(positionFromLabel(labelFor(n))).toBe(n);
      }),
    );
  });

  it('pads to two digits and rejects non-labels', () => {
    expect(labelFor(1)).toBe('Shoe 01');
    expect(labelFor(12)).toBe('Shoe 12');
    expect(positionFromLabel('Shoe 1')).toBeNull();
    expect(positionFromLabel('Shoe 00')).toBeNull();
    expect(positionFromLabel('shoe 01')).toBeNull();
    expect(() => labelFor(0)).toThrow(RangeError);
  });
});

describe('P3 renumber', () => {
  it('yields exactly 1..n, keeps order and length', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.uuid(), { maxLength: 10 }), (ids) => {
        const out = renumber(ids);
        expect(out.size).toBe(ids.length);
        expect(ids.map((id) => out.get(id))).toEqual(ids.map((_, i) => i + 1));
      }),
    );
  });

  it('after removing any shoe, remaining positions are contiguous in their old order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 50 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.nat(),
        (positions, pick) => {
          const shoes = positions.map((p, i) => ({ id: `s${i}`, position: p }));
          const removed = shoes[pick % shoes.length];
          const rest = orderByPosition(shoes.filter((s) => s !== removed));
          const next = renumber(rest.map((s) => s.id));
          expect(rest.map((s) => next.get(s.id))).toEqual(
            rest.map((_, i) => i + 1),
          );
        },
      ),
    );
  });
});

describe('P4 canFinish (oracle)', () => {
  it('true ⇔ at least one shoe and every shoe has 4 distinct views', () => {
    fc.assert(
      fc.property(fc.array(shoeViewsArb, { maxLength: 5 }), (shoes) => {
        const oracle =
          shoes.length > 0 && shoes.every((s) => new Set(s.views).size === 4);
        expect(canFinish(shoes)).toBe(oracle);
        expect(incompleteShoes(shoes).length === 0).toBe(
          shoes.every((s) => new Set(s.views).size === 4),
        );
      }),
    );
  });

  it('an empty shoe blocks finish (Q18)', () => {
    const shoes = [
      { id: 'a', position: 1, views: [...SHOE_VIEWS] },
      { id: 'b', position: 2, views: [] },
    ];
    expect(canFinish(shoes)).toBe(false);
    expect(incompleteShoes(shoes)).toEqual([
      { shoeId: 'b', label: 'Shoe 02', missing: [...SHOE_VIEWS] },
    ]);
  });
});

describe('P6 sniffImageType (oracle)', () => {
  it('detects JPEG/PNG from magic bytes only', () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const isJpeg = JPEG_HEAD.slice(0, 3).every((b, i) => bytes[i] === b);
        const isPng = PNG_HEAD.every((b, i) => bytes[i] === b);
        expect(sniffImageType(bytes)).toBe(
          isJpeg ? 'jpeg' : isPng ? 'png' : null,
        );
      }),
    );
  });

  it('rejects GIF and empty input', () => {
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('checkPhoto + config parsing', () => {
  it('accepts exactly: non-empty, ≤ max bytes, allowed type', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2000 }),
        fc.constantFrom('jpeg', 'png', null),
        (size, type) => {
          const r = checkPhoto({ size, type: type }, LIMITS);
          const ok = size > 0 && size <= LIMITS.photoMaxBytes && type !== null;
          expect(r === null).toBe(ok);
        },
      ),
    );
  });

  it('parsePhotoTypes: jpg is an alias, junk falls back to the default', () => {
    expect(parsePhotoTypes('jpg,png')).toEqual(['jpeg', 'png']);
    expect(parsePhotoTypes('JPEG')).toEqual(['jpeg']);
    expect(parsePhotoTypes('gif')).toEqual(['jpeg', 'png']);
    expect(parsePhotoTypes(undefined)).toEqual(['jpeg', 'png']);
  });

  it('scanPhotoKey follows the S3 layout', () => {
    expect(scanPhotoKey('s', 'h', 'top', 'jpeg')).toBe('scans/s/h/top.jpg');
    expect(scanPhotoKey('s', 'h', 'sole', 'png')).toBe('scans/s/h/sole.png');
  });
});

describe('P5 decideAlbumShoes', () => {
  it('one decision per shoe, in order; saved count ≤ capacity', () => {
    fc.assert(
      fc.property(
        manifestArb,
        filesArb(LIMITS.photoMaxBytes),
        fc.integer({ min: 0, max: 4 }),
        (manifest, files, cap) => {
          const out = decideAlbumShoes(manifest, files, LIMITS, cap);
          expect(out.map((d) => d.ref)).toEqual(manifest.map((s) => s.ref));
          expect(out.filter((d) => d.accepted).length).toBeLessThanOrEqual(cap);
        },
      ),
    );
  });

  it('accepted ⇔ oracle: non-empty, valid distinct views, fields unique across manifest, files present and valid, capacity left', () => {
    fc.assert(
      fc.property(
        manifestArb,
        filesArb(LIMITS.photoMaxBytes),
        fc.integer({ min: 0, max: 4 }),
        (manifest, files, cap) => {
          const counts = new Map<string, number>();
          manifest.forEach((s) =>
            s.files.forEach((f) =>
              counts.set(f.field, (counts.get(f.field) ?? 0) + 1),
            ),
          );
          let left = cap;
          const expected = manifest.map((s) => {
            const views = s.files.map((f) => f.view);
            const valid =
              s.files.length > 0 &&
              views.every((v) =>
                (SHOE_VIEWS as readonly string[]).includes(v),
              ) &&
              new Set(views).size === views.length &&
              s.files.every((f) => counts.get(f.field) === 1) &&
              s.files.every((f) => {
                const info = files.get(f.field);
                return info !== undefined && checkPhoto(info, LIMITS) === null;
              });
            if (!valid) return false;
            if (left < 1) return false;
            left -= 1;
            return true;
          });
          const actual = decideAlbumShoes(manifest, files, LIMITS, cap).map(
            (d) => d.accepted,
          );
          expect(actual).toEqual(expected);
        },
      ),
    );
  });

  it('accepted shoes carry every file with its sniffed type', () => {
    const files = new Map([
      ['f1', { size: 10, type: 'jpeg' as const }],
      ['f2', { size: 10, type: 'png' as const }],
    ]);
    const [d] = decideAlbumShoes(
      [
        {
          ref: 'a',
          files: [
            { field: 'f1', view: 'top' },
            { field: 'f2', view: 'sole' },
          ],
        },
      ],
      files,
      LIMITS,
      1,
    );
    expect(d).toEqual({
      ref: 'a',
      accepted: true,
      files: [
        { field: 'f1', view: 'top', type: 'jpeg' },
        { field: 'f2', view: 'sole', type: 'png' },
      ],
    });
  });
});
