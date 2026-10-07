// Integration tests for CatalogService (F3 E14–E19 + resolution helpers)
// against a real PostgreSQL. A small fixture is inserted with a unique tag
// and removed afterwards, so the suite is safe next to a real seed.
//
// Skipped unless SCAN_IT_DB=1 (same switch as the scan suites).
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { CatalogConfig } from '../config/catalog.config';
import { CatalogService } from './catalog.service';
import { CatalogBrandEntity } from './entities/catalog-brand.entity';
import { CatalogCategoryEntity } from './entities/catalog-category.entity';
import { CatalogProductEntity } from './entities/catalog-product.entity';
import { CatalogSizeEntity } from './entities/catalog-size.entity';
import { CatalogSubcategoryEntity } from './entities/catalog-subcategory.entity';

loadEnv();
const RUN = process.env.SCAN_IT_DB === '1';
const d = RUN ? describe : describe.skip;

const CFG: CatalogConfig = { mutedEndpoints: [], listMax: 500, source: null };

d('CatalogService (integration, real Postgres)', () => {
  let moduleRef: TestingModule;
  let svc: CatalogService;
  let ds: DataSource;
  const TAG = `ct-${randomUUID().slice(0, 8)}`;
  let zeta: CatalogBrandEntity;
  let alpha: CatalogBrandEntity;
  let inactive: CatalogBrandEntity;
  let cat: CatalogCategoryEntity;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'localhost',
          port: Number.parseInt(process.env.DB_PORT ?? '5433', 10),
          username: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          entities: [__dirname + '/../**/*.entity{.ts,.js}'],
          synchronize: false,
          logging: false,
        }),
        TypeOrmModule.forFeature([
          CatalogBrandEntity,
          CatalogCategoryEntity,
          CatalogSizeEntity,
          CatalogProductEntity,
        ]),
      ],
      providers: [
        CatalogService,
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'catalog' ? CFG : undefined) },
        },
      ],
    }).compile();
    svc = moduleRef.get(CatalogService);
    ds = moduleRef.get(DataSource);

    const brands = ds.getRepository(CatalogBrandEntity);
    zeta = await brands.save(
      brands.create({ slug: `${TAG}-zeta`, name: `${TAG} Zeta` }),
    );
    alpha = await brands.save(
      brands.create({ slug: `${TAG}-alpha`, name: `${TAG} Alpha` }),
    );
    inactive = await brands.save(
      brands.create({
        slug: `${TAG}-gone`,
        name: `${TAG} Gone`,
        isActive: false,
      }),
    );
    const cats = ds.getRepository(CatalogCategoryEntity);
    cat = await cats.save(
      cats.create({ slug: `${TAG}-boots`, name: `${TAG} Boots` }),
    );
    const subs = ds.getRepository(CatalogSubcategoryEntity);
    await subs.save([
      subs.create({ categoryId: cat.id, slug: 'snow', name: 'Snow' }),
      subs.create({ categoryId: cat.id, slug: 'chelsea', name: 'Chelsea' }),
      subs.create({
        categoryId: cat.id,
        slug: 'old',
        name: 'Old',
        isActive: false,
      }),
    ]);
    const sizes = ds.getRepository(CatalogSizeEntity);
    await sizes.save([
      sizes.create({
        brandId: zeta.id,
        system: 'US',
        label: '10',
        sortOrder: 2,
      }),
      sizes.create({
        brandId: zeta.id,
        system: 'US',
        label: '7.5',
        sortOrder: 1,
      }),
      sizes.create({
        brandId: zeta.id,
        system: 'US',
        label: '9',
        sortOrder: 3,
      }),
    ]);
    const products = ds.getRepository(CatalogProductEntity);
    await products.save([
      products.create({
        brandId: zeta.id,
        sku: `${TAG}-1`,
        model: 'Trail Runner',
        modelCode: 'TR1',
        colour: 'Black',
        size: '9',
        msrp: 100,
      }),
      products.create({
        brandId: zeta.id,
        sku: `${TAG}-2`,
        model: 'Trail Runner',
        modelCode: 'TR2',
        colour: 'Olive Green',
        size: '10',
        msrp: 110,
      }),
      products.create({
        brandId: zeta.id,
        sku: `${TAG}-3`,
        model: 'Alpine',
        colour: 'Black',
        size: '9',
        msrp: null,
      }),
      products.create({
        brandId: zeta.id,
        sku: `${TAG}-4`,
        model: 'Hidden',
        colour: 'Red',
        size: '9',
        isActive: false,
      }),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (ds) {
      await ds
        .getRepository(CatalogBrandEntity)
        .delete([zeta.id, alpha.id, inactive.id]); // cascades
      await ds.getRepository(CatalogCategoryEntity).delete({ id: cat.id });
    }
    await moduleRef?.close();
  });

  it('E14 brands: active only, A→Z, prefix search, LIKE wildcards escaped', async () => {
    const all = await svc.listBrands(TAG);
    expect(all.items.map((b) => b.id)).toEqual([alpha.id, zeta.id]);
    expect(all.items.map((b) => b.id)).not.toContain(inactive.id);
    const one = await svc.listBrands(`${TAG} Z`);
    expect(one.items.map((b) => b.id)).toEqual([zeta.id]);
    const none = await svc.listBrands(`${TAG}%`);
    expect(none.items).toEqual([]);
  });

  it('E15 sizes: per-brand in numeric order, generic fallback for unknown / sizeless brands', async () => {
    const perBrand = await svc.listSizes(zeta.id);
    expect(perBrand.generic).toBe(false);
    expect(perBrand.items.map((s) => s.label)).toEqual(['7.5', '9', '10']);
    const fallback = await svc.listSizes(alpha.id);
    expect(fallback.generic).toBe(true);
    const generic = await svc.listSizes();
    expect(generic.items.map((s) => s.label)).toEqual(
      fallback.items.map((s) => s.label),
    );
  });

  it('E16 categories: nested active sub-categories sorted by name', async () => {
    const view = await svc.listCategories();
    const mine = view.items.find((c) => c.id === cat.id)!;
    expect(mine.subcategories.map((s) => s.name)).toEqual(['Chelsea', 'Snow']);
  });

  it('E17 / E18 models and colours: distinct, active only, filtered', async () => {
    const models = await svc.listModels(zeta.id);
    expect(models.items.map((m) => m.model)).toEqual([
      'Alpine',
      'Trail Runner',
    ]);
    expect(
      models.items.find((m) => m.model === 'Trail Runner')?.modelCode,
    ).toBe('TR1');
    expect(
      (await svc.listModels(zeta.id, 'tra')).items.map((m) => m.model),
    ).toEqual(['Trail Runner']);
    expect((await svc.listColours(zeta.id)).items.map((c) => c.colour)).toEqual(
      ['Black', 'Olive Green'],
    );
    expect(
      (await svc.listColours(zeta.id, 'alpine')).items.map((c) => c.colour),
    ).toEqual(['Black']);
    expect(svc.options().genders).toEqual(['men', 'women', 'unisex', 'kids']);
  });

  it('resolution: by id (active only), by name slug, bulk by names', async () => {
    const m = ds.manager;
    expect((await svc.brandById(m, zeta.id))?.id).toBe(zeta.id);
    expect(await svc.brandById(m, inactive.id)).toBeNull();
    expect((await svc.brandByName(m, `${TAG} ZETA`))?.id).toBe(zeta.id);
    expect(await svc.brandByName(m, null)).toBeNull();
    const map = await svc.brandsByNames(m, [`${TAG} Alpha`, null, 'nope']);
    expect([...map.keys()]).toEqual([`${TAG}-alpha`]);
  });

  it('matchProduct: brand + model required; colour and size narrow; never throws', async () => {
    const m = ds.manager;
    expect(
      await svc.matchProduct(m, null, 'Trail Runner', null, null),
    ).toBeNull();
    expect(await svc.matchProduct(m, zeta.id, null, null, null)).toBeNull();
    expect(await svc.matchProduct(m, zeta.id, 'nope', null, null)).toBeNull();
    expect(
      (await svc.matchProduct(m, zeta.id, 'trail runner', 'olive', null))?.sku,
    ).toBe(`${TAG}-2`);
    expect(
      (await svc.matchProduct(m, zeta.id, 'Trail Runner', null, '9'))?.sku,
    ).toBe(`${TAG}-1`);
    expect(await svc.matchProduct(m, zeta.id, 'Hidden', null, null)).toBeNull();
  });
});
