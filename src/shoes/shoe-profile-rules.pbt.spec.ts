// Property tests for the pure F5 rules (how-to.md §5: P1, P3, P4, P5, P8).
import fc from 'fast-check';
import {
  ACTION_TAKEN,
  CONDITION_CODES,
  GENDERS,
  MATERIAL_PARTS,
} from '../scan/scan.types';
import {
  applyEdit,
  canDeletePhoto,
  conditionViewFor,
  materialsFor,
  nextPrimary,
  nextSortOrder,
  summaryOf,
  type EditField,
  type EditInput,
  type EditableShoe,
  type PhotoRef,
} from './shoe-profile-rules';

const maybeText = (max: number) =>
  fc.option(fc.string({ maxLength: max }), { nil: null });
const uuidish = fc.uuid();

const editableArb: fc.Arbitrary<EditableShoe> = fc.record({
  brandId: fc.option(uuidish, { nil: null }),
  brand: fc.string({ minLength: 1, maxLength: 40 }),
  model: maybeText(40),
  colorway: maybeText(30),
  sizeId: fc.option(uuidish, { nil: null }),
  size: maybeText(6),
  shoeTypeId: fc.option(uuidish, { nil: null }),
  shoeType: maybeText(20),
  gender: fc.option(fc.constantFrom(...GENDERS), { nil: null }),
  actionTaken: fc.constantFrom(...ACTION_TAKEN),
  actionTakenAt: fc.option(fc.date(), { nil: null }),
  primaryPhotoId: fc.option(uuidish, { nil: null }),
});

/** Every field independently present or absent (undefined = untouched). */
const inputArb: fc.Arbitrary<EditInput> = fc
  .record(
    {
      brand: fc.tuple(
        fc.option(uuidish, { nil: null }),
        fc.string({ minLength: 1, maxLength: 40 }),
      ),
      model: maybeText(40),
      color: maybeText(30),
      size: fc.tuple(fc.option(uuidish, { nil: null }), maybeText(6)),
      shoeType: fc.tuple(fc.option(uuidish, { nil: null }), maybeText(20)),
      gender: fc.option(fc.constantFrom(...GENDERS), { nil: null }),
      actionTaken: fc.constantFrom(...ACTION_TAKEN),
      primaryPhotoId: fc.option(uuidish, { nil: null }),
    },
    { requiredKeys: [] },
  )
  .map((r) => {
    const out: EditInput = {};
    if (r.brand !== undefined) {
      out.brandId = r.brand[0];
      out.brand = r.brand[1];
    }
    if (r.model !== undefined) out.model = r.model;
    if (r.color !== undefined) out.color = r.color;
    if (r.size !== undefined) {
      out.sizeId = r.size[0];
      out.size = r.size[1];
    }
    if (r.shoeType !== undefined) {
      out.shoeTypeId = r.shoeType[0];
      out.shoeType = r.shoeType[1];
    }
    if (r.gender !== undefined) out.gender = r.gender;
    if (r.actionTaken !== undefined) out.actionTaken = r.actionTaken;
    if (r.primaryPhotoId !== undefined) out.primaryPhotoId = r.primaryPhotoId;
    return out;
  });

const NOW = new Date('2026-10-12T10:00:00Z');

describe('F5-P1 applyEdit', () => {
  it('never touches a field absent from the input; changed = fields whose value differs', () => {
    fc.assert(
      fc.property(editableArb, inputArb, (shoe, input) => {
        const { next, changed } = applyEdit(shoe, input, NOW);
        const touched = new Set<EditField>();
        if (input.brandId !== undefined && input.brand !== undefined) {
          touched.add('brandId');
          touched.add('brand');
        }
        if (input.model !== undefined) touched.add('model');
        if (input.color !== undefined) touched.add('colorway');
        if (input.sizeId !== undefined) {
          touched.add('sizeId');
          touched.add('size');
        }
        if (input.shoeTypeId !== undefined) {
          touched.add('shoeTypeId');
          touched.add('shoeType');
        }
        if (input.gender !== undefined) touched.add('gender');
        if (input.actionTaken !== undefined) {
          touched.add('actionTaken');
          touched.add('actionTakenAt');
        }
        if (input.primaryPhotoId !== undefined) touched.add('primaryPhotoId');
        for (const k of Object.keys(shoe) as EditField[]) {
          if (!touched.has(k)) expect(next[k]).toEqual(shoe[k]);
          expect(changed.has(k)).toBe(next[k] !== shoe[k]);
        }
      }),
    );
  });

  it('actionTakenAt is stamped on a real action and cleared on none; untouched when unchanged', () => {
    fc.assert(
      fc.property(editableArb, fc.constantFrom(...ACTION_TAKEN), (shoe, a) => {
        const { next } = applyEdit(shoe, { actionTaken: a }, NOW);
        if (a === shoe.actionTaken) {
          expect(next.actionTakenAt).toEqual(shoe.actionTakenAt);
        } else if (a === 'none') {
          expect(next.actionTakenAt).toBeNull();
        } else {
          expect(next.actionTakenAt).toEqual(NOW);
        }
      }),
    );
  });

  it('rematch iff brand / model / colour / size changed; revalue iff brand changed', () => {
    fc.assert(
      fc.property(editableArb, inputArb, (shoe, input) => {
        const r = applyEdit(shoe, input, NOW);
        const identity = (['brand', 'model', 'colorway', 'size'] as const).some(
          (f) => r.changed.has(f),
        );
        expect(r.rematch).toBe(identity);
        expect(r.revalue).toBe(r.changed.has('brand'));
      }),
    );
  });

  it('a blank brand name never overwrites the stored brand', () => {
    fc.assert(
      fc.property(editableArb, fc.constantFrom('', '   '), (shoe, blank) => {
        const { next, changed } = applyEdit(
          shoe,
          { brandId: null, brand: blank },
          NOW,
        );
        expect(next.brand).toBe(shoe.brand);
        expect(changed.has('brand')).toBe(false);
      }),
    );
  });
});

describe('F5-P3 photos', () => {
  const photoArb: fc.Arbitrary<PhotoRef> = fc.record({
    id: uuidish,
    sortOrder: fc.integer({ min: 0, max: 20 }),
    createdAt: fc.date({ min: new Date(0), max: new Date(4102444800000) }),
  });
  const photosArb = fc.uniqueArray(photoArb, {
    minLength: 1,
    maxLength: 9,
    selector: (p) => p.id,
  });

  it('nextPrimary returns a remaining photo whenever one exists, the lowest sortOrder', () => {
    fc.assert(
      fc.property(photosArb, fc.nat(), (photos, i) => {
        const removed = photos[i % photos.length].id;
        const pick = nextPrimary(photos, removed);
        const rest = photos.filter((p) => p.id !== removed);
        if (rest.length === 0) {
          expect(pick).toBeNull();
        } else {
          expect(rest.map((p) => p.id)).toContain(pick);
          const min = Math.min(...rest.map((p) => p.sortOrder));
          expect(rest.find((p) => p.id === pick)!.sortOrder).toBe(min);
        }
      }),
    );
  });

  it('canDeletePhoto is false exactly for one photo; nextSortOrder is above every existing one', () => {
    fc.assert(
      fc.property(photosArb, (photos) => {
        expect(canDeletePhoto(photos.length)).toBe(photos.length > 1);
        const n = nextSortOrder(photos);
        for (const p of photos) expect(n).toBeGreaterThan(p.sortOrder);
      }),
    );
    expect(canDeletePhoto(1)).toBe(false);
    expect(canDeletePhoto(0)).toBe(false);
    expect(nextSortOrder([])).toBe(0);
  });
});

describe('F5-P4 materialsFor / condition view', () => {
  it('four distinct parts, every row static, for any shoe type text or null', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ maxLength: 30 }), { nil: null }),
        (slug) => {
          const rows = materialsFor(slug);
          expect(rows.map((r) => r.part)).toEqual([...MATERIAL_PARTS]);
          for (const r of rows) {
            expect(r.material.length).toBeGreaterThan(0);
            expect(r.source).toBe('static');
          }
        },
      ),
    );
  });

  it('conditionViewFor is total: unknown code or null → nulls, known code → its row', () => {
    const mappings = CONDITION_CODES.map((code, i) => ({
      code,
      label: `L${i}`,
      gradeLetter: `G${i}`,
      description: `D${i}`,
      filterGroup: `F${i}`,
    }));
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom(...CONDITION_CODES), { nil: null }),
        (code) => {
          const v = conditionViewFor(code, mappings);
          expect(v.code).toBe(code);
          if (code === null) {
            expect(v.label).toBeNull();
            expect(v.grade).toBeNull();
          } else {
            const i = CONDITION_CODES.indexOf(code);
            expect(v).toEqual({
              code,
              grade: `G${i}`,
              label: `L${i}`,
              description: `D${i}`,
              filterGroup: `F${i}`,
            });
          }
        },
      ),
    );
    expect(conditionViewFor('C2', [])).toEqual({
      code: 'C2',
      grade: null,
      label: null,
      description: null,
      filterGroup: null,
    });
  });
});

describe('F5-P5 summaryOf', () => {
  it('pairs = non-deleted count, potentialValue = sum of resaleMax (null = 0), actionTaken ignored', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            deletedAt: fc.option(fc.date(), { nil: null }),
            resaleMax: fc.option(
              fc
                .double({ min: 0, max: 5000, noNaN: true })
                .map((v) => Math.round(v * 100) / 100),
              { nil: null },
            ),
          }),
          { maxLength: 30 },
        ),
        (shoes) => {
          const s = summaryOf(shoes);
          const live = shoes.filter((x) => x.deletedAt === null);
          expect(s.pairs).toBe(live.length);
          const expected =
            Math.round(live.reduce((a, x) => a + (x.resaleMax ?? 0), 0) * 100) /
            100;
          expect(Math.abs(s.potentialValue - expected)).toBeLessThan(0.011);
        },
      ),
    );
  });
});

describe('F5-P8 photo cap (stateful model)', () => {
  type Model = { count: number };
  const MAX = 8;
  class Upload implements fc.Command<Model, Model> {
    check = () => true;
    run(m: Model, r: Model) {
      if (r.count < MAX) r.count += 1; // 409 PHOTO_LIMIT_REACHED otherwise
      m.count = r.count;
      expect(r.count).toBeLessThanOrEqual(MAX);
    }
    toString = () => 'upload';
  }
  class Delete implements fc.Command<Model, Model> {
    check = () => true;
    run(m: Model, r: Model) {
      if (canDeletePhoto(r.count)) r.count -= 1; // 409 LAST_PHOTO otherwise
      m.count = r.count;
      expect(r.count).toBeGreaterThanOrEqual(1);
    }
    toString = () => 'delete';
  }
  class Rescan implements fc.Command<Model, Model> {
    constructor(private readonly uploads: number) {}
    check = () => true;
    run(m: Model, r: Model) {
      // scan rows replaced by 4 new views; uploads kept (bounded by the cap)
      const uploads = Math.min(this.uploads, Math.max(0, r.count - 1));
      r.count = Math.min(MAX, 4 + uploads);
      m.count = r.count;
      expect(r.count).toBeLessThanOrEqual(MAX);
    }
    toString = () => `rescan(${this.uploads})`;
  }
  it('never exceeds the cap nor drops below one photo', () => {
    fc.assert(
      fc.property(
        fc.commands(
          [
            fc.constant(new Upload()),
            fc.constant(new Delete()),
            fc.integer({ min: 0, max: 6 }).map((n) => new Rescan(n)),
          ],
          { maxCommands: 40 },
        ),
        (cmds) => {
          fc.modelRun(
            () => ({ model: { count: 4 }, real: { count: 4 } }),
            cmds,
          );
        },
      ),
    );
  });
});
