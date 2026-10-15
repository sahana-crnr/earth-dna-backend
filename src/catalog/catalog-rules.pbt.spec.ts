// Property-based tests for the pure catalog rules (how-to.md §5 P6, P8).
import fc from 'fast-check';
import {
  cleanModel,
  genericUsSizes,
  importProducts,
  importTaxonomy,
  normalizeGender,
  normalizeSize,
  sizeOrder,
  sizesByBrand,
  slugify,
  titleCase,
  type TaxonomyRow,
  shoeTypeFor,
} from './catalog-rules';

const word = fc.stringMatching(/^[A-Za-z0-9 _-]{1,16}$/);

describe('slugify / titleCase', () => {
  it('slug is lower-case [a-z0-9-], no leading/trailing dash, idempotent', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        const slug = slugify(s);
        expect(slug).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/);
        expect(slugify(slug)).toBe(slug);
      }),
    );
  });

  it('pinned examples', () => {
    expect(slugify('On Running')).toBe('on-running');
    expect(slugify('361°')).toBe('361');
    expect(slugify('new_balance')).toBe('new-balance');
    expect(titleCase('new_balance')).toBe('New Balance');
    expect(titleCase('on')).toBe('ON');
    expect(titleCase('athletic_shoes')).toBe('Athletic Shoes');
  });
});

describe('F3-P8 normalizeSize / sizeOrder', () => {
  it('accepts whole and half sizes 1..20 (with an optional width word), nothing else', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.boolean(),
        fc.constantFrom('', ' Wide', ' wide', ' W', ' Medium', ' D'),
        (n, half, suffix) => {
          const label = half && n < 20 ? `${n}.5` : `${n}`;
          expect(normalizeSize(`${label}${suffix}`)).toBe(label);
        },
      ),
    );
    for (const bad of [
      '9-10',
      'Medium',
      'US: Men 14.5-15, Women 15.5-16',
      '',
      '0',
      '21',
      '7.25',
      'XL',
      null,
      undefined,
    ]) {
      expect(normalizeSize(bad as string)).toBeNull();
    }
    expect(normalizeSize('US 7.5')).toBe('7.5');
    expect(normalizeSize('8.0')).toBe('8');
  });

  it('sizeOrder is numeric, de-duplicated and stable', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .integer({ min: 2, max: 40 })
            .map((n) => `${n / 2}`.replace('.0', '')),
        ),
        (labels) => {
          const out = sizeOrder(labels);
          expect(new Set(out).size).toBe(out.length);
          expect(new Set(out)).toEqual(new Set(labels));
          for (let i = 1; i < out.length; i += 1) {
            expect(Number(out[i - 1])).toBeLessThan(Number(out[i]));
          }
          expect(sizeOrder(out)).toEqual(out);
        },
      ),
    );
  });

  it('the generic US list is 4..15 by halves, already in order', () => {
    const g = genericUsSizes();
    expect(g[0]).toBe('4');
    expect(g[g.length - 1]).toBe('15');
    expect(g).toHaveLength(23);
    expect(sizeOrder(g)).toEqual(g);
  });

  it('normalizeGender maps aliases and rejects the rest', () => {
    expect(normalizeGender('Women')).toBe('women');
    expect(normalizeGender('male')).toBe('men');
    expect(normalizeGender('')).toBeNull();
    expect(normalizeGender('boys')).toBeNull();
  });
});

describe('F3-P6 importTaxonomy', () => {
  const rowArb: fc.Arbitrary<TaxonomyRow> = fc.record({
    category: fc.oneof(word, fc.constant('')),
    subcategory: fc.option(word, { nil: null }),
    brand: fc.oneof(word, fc.constant('')),
  });

  it('slugs are unique per level, every usable row is represented, blanks are skipped', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), (rows) => {
        const plan = importTaxonomy(rows);
        const uniq = (xs: string[]) => new Set(xs).size === xs.length;
        expect(uniq(plan.categories.map((c) => c.slug))).toBe(true);
        expect(uniq(plan.brands.map((b) => b.slug))).toBe(true);
        expect(
          uniq(plan.subcategories.map((s) => `${s.categorySlug}/${s.slug}`)),
        ).toBe(true);
        const usable = rows.filter(
          (r) => slugify(r.category) && slugify(r.brand),
        );
        expect(plan.skipped).toBe(rows.length - usable.length);
        for (const r of usable) {
          expect(
            plan.categories.some((c) => c.slug === slugify(r.category)),
          ).toBe(true);
          expect(plan.brands.some((b) => b.slug === slugify(r.brand))).toBe(
            true,
          );
        }
        // every link points at an existing brand and subcategory
        for (const l of plan.links) {
          expect(plan.brands.some((b) => b.slug === l.brandSlug)).toBe(true);
          expect(
            plan.subcategories.some(
              (s) =>
                s.categorySlug === l.categorySlug &&
                s.slug === l.subcategorySlug,
            ),
          ).toBe(true);
        }
      }),
    );
  });

  it('is idempotent: re-importing the plan as rows yields the same plan', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), (rows) => {
        const plan = importTaxonomy(rows);
        const again = importTaxonomy([
          ...plan.links.map((l) => ({
            category: l.categorySlug,
            subcategory: l.subcategorySlug,
            brand: l.brandSlug,
          })),
          // brands/categories that had no subcategory link
          ...plan.brands.map((b) => ({
            category: plan.categories[0]?.slug ?? 'x',
            subcategory: null,
            brand: b.slug,
          })),
          ...plan.categories.map((c) => ({
            category: c.slug,
            subcategory: null,
            brand: plan.brands[0]?.slug ?? 'x',
          })),
        ]);
        expect(again.brands).toEqual(plan.brands);
        expect(again.categories).toEqual(plan.categories);
        expect(again.subcategories).toEqual(plan.subcategories);
        expect(again.links).toEqual(plan.links);
      }),
    );
  });
});

describe('cleanModel', () => {
  it('strips trailing colour and size segments, keeps the model, never returns empty', () => {
    expect(
      cleanModel(
        'Ghost 13 Running Shoe - Black/Grey/Stormy - 9.5 Medium',
        'Black/Grey/Stormy',
        '9.5 Medium',
      ),
    ).toBe('Ghost 13 Running Shoe');
    expect(cleanModel('Ultraboost 22 - Core Black', 'Core Black', '9')).toBe(
      'Ultraboost 22',
    );
    expect(cleanModel('Air Max 90 - 10 Wide', null, '10 Wide')).toBe(
      'Air Max 90',
    );
    expect(cleanModel('Chuck Taylor - Hi', 'White', '8')).toBe(
      'Chuck Taylor - Hi',
    );
    expect(cleanModel(' - 9.5', null, '9.5')).toBe('- 9.5');
    expect(cleanModel('', 'x', 'y')).toBeNull();
    expect(cleanModel(null, null, null)).toBeNull();
  });

  it('is idempotent and never longer than its input', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.option(word, { nil: null }),
        fc.option(word, { nil: null }),
        (m, c, s) => {
          const once = cleanModel(m, c, s);
          if (once === null) {
            expect(m.trim()).toBe('');
            return;
          }
          expect(once.length).toBeLessThanOrEqual(m.trim().length);
          expect(cleanModel(once, c, s)).toBe(once);
        },
      ),
    );
  });
});

describe('importProducts / sizesByBrand', () => {
  it('keeps the last row per sku, drops rows without sku or brand, normalises size and gender', () => {
    const { products, skipped } = importProducts([
      {
        sku: 'A1',
        brand: 'nike',
        model: ' Air Max ',
        modelCode: null,
        category: 'athletic_shoes',
        subCategory: null,
        silhouette: null,
        gender: 'Women',
        colour: 'White',
        size: '7.5 Wide',
        msrp: 120,
        releaseDate: '2025-01-01',
        title: null,
      },
      {
        sku: 'A1',
        brand: 'nike',
        model: 'Air Max 90',
        modelCode: null,
        category: null,
        subCategory: null,
        silhouette: null,
        gender: 'men',
        colour: 'Black',
        size: '9-10',
        msrp: null,
        releaseDate: null,
        title: 't',
      },
      {
        sku: '',
        brand: 'nike',
        model: null,
        modelCode: null,
        category: null,
        subCategory: null,
        silhouette: null,
        gender: null,
        colour: null,
        size: null,
        msrp: null,
        releaseDate: null,
        title: null,
      },
      {
        sku: 'B2',
        brand: '',
        model: null,
        modelCode: null,
        category: null,
        subCategory: null,
        silhouette: null,
        gender: null,
        colour: null,
        size: null,
        msrp: null,
        releaseDate: null,
        title: null,
      },
      {
        sku: 'C3',
        brand: 'Nike',
        model: 'Pegasus',
        modelCode: 'PG',
        category: null,
        subCategory: null,
        silhouette: null,
        gender: 'kids',
        colour: null,
        size: '4',
        msrp: '80' as unknown as number,
        releaseDate: null,
        title: null,
      },
    ]);
    expect(skipped).toBe(2);
    expect(products.map((p) => p.sku)).toEqual(['A1', 'C3']);
    const a1 = products[0];
    expect(a1.model).toBe('Air Max 90');
    expect(products[1].model).toBe('Pegasus');
    expect(a1.size).toBeNull();
    expect(a1.sizeRaw).toBe('9-10');
    expect(a1.gender).toBe('men');
    expect(products[1].msrp).toBe(80);
    expect(products[1].brandSlug).toBe('nike');
    expect(
      sizesByBrand([
        ...products,
        { brandSlug: 'nike', size: '7.5' },
        { brandSlug: 'nike', size: '7.5' },
      ]).get('nike'),
    ).toEqual(['4', '7.5']);
  });
});

describe('F5-D20 shoeTypeFor (whole-token match, PR 15)', () => {
  it.each([
    ['running_shoes', 'athletic-shoes'],
    ['Athletic Shoes', 'athletic-shoes'],
    ['workout-shoes', 'athletic-shoes'],
    ['hiking-shoes', 'athletic-shoes'],
    ['hiking-sandals', 'sandals'],
    ['hiking-boots', 'boots'],
    ['chelsea_boots', 'boots'],
    ['platform-wedges', 'dress-shoes'],
    ['dress-shoes', 'dress-shoes'],
    ['loafers', 'dress-shoes'],
    ['slippers', 'slippers'],
    ['flip-flops', 'sandals'],
    ['canvas-shoes', 'casual-shoes'],
    ['specialty-footwear', null],
    ['', null],
  ])('%s → %s', (input, want) => {
    expect(shoeTypeFor(input)).toBe(want);
  });
  it('never matches inside another word', () => {
    expect(shoeTypeFor('workout')).toBe('athletic-shoes');
    expect(shoeTypeFor('platform')).toBe('dress-shoes');
    expect(shoeTypeFor('network')).toBeNull();
  });
});
