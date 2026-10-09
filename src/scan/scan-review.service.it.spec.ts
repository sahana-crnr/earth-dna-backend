// Integration tests for ScanReviewService (F3) against a real PostgreSQL
// (local-infra, port 5433). F1 + F2 services drive a scan to `review`, a tiny
// catalog fixture is seeded, then confirm / reject are exercised end to end.
//
// Skipped unless SCAN_IT_DB=1, so `npm test` needs no database:
//   cd ../local-infra && docker compose up -d
//   npm run test:scan-it
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../common/errors/api-error';
import { PhotoStorage } from '../storage/photo-storage';
import { UserEntity } from '../user/entities/user.entity';
import { CatalogService } from '../catalog/catalog.service';
import { CatalogBrandEntity } from '../catalog/entities/catalog-brand.entity';
import { CatalogCategoryEntity } from '../catalog/entities/catalog-category.entity';
import { CatalogProductEntity } from '../catalog/entities/catalog-product.entity';
import { CatalogSizeEntity } from '../catalog/entities/catalog-size.entity';
import type { CatalogConfig } from '../config/catalog.config';
import type { ScanConfig } from '../config/scan.config';
import { ShoeEntity } from '../shoes/entities/shoe.entity';
import { ScanEntity } from './entities/scan.entity';
import { ScanPhotoEntity } from './entities/scan-photo.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { ScanShoeResultEntity } from './entities/scan-shoe-result.entity';
import { ShoeFeedbackEntity } from './entities/shoe-feedback.entity';
import { ScanService } from './scan.service';
import { ScanResultService } from './scan-result.service';
import { ScanResultsBuilder } from './scan-results.builder';
import { ScanReviewService } from './scan-review.service';
import { SHOE_VIEWS } from './scan.types';
import type { SubmitShoeResultDto } from './dto/submit-shoe-result.dto';

loadEnv();
const RUN = process.env.SCAN_IT_DB === '1';
const d = RUN ? describe : describe.skip;

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const file = { fieldname: 'file', buffer: PNG, size: PNG.length };

class FakeStorage extends PhotoStorage {
  isConfigured() {
    return true;
  }
  put() {
    return Promise.resolve();
  }
  delete() {
    return Promise.resolve();
  }
  signedGetUrl(key: string) {
    return Promise.resolve(`fake://${key}`);
  }
}

const CFG: ScanConfig = {
  maxShoes: 4,
  albumMaxShoes: 3,
  albumMaxPhotos: 12,
  photoMaxBytes: 1024,
  photoAllowedTypes: ['jpeg', 'png'],
  maxOpenDrafts: 0,
  deleteObjectsOnRemove: true,
  draftAbandonDays: 30,
  photoUrlTtlSeconds: 60,
  resultMaxCandidates: 3,
  resultRawMaxBytes: 8192,
  valuePlaceholder: true,
  thumbnailView: 'right',
};
const CATALOG_CFG: CatalogConfig = {
  mutedEndpoints: [],
  listMax: 500,
  source: null,
};

const RESULT: SubmitShoeResultDto = {
  modelVersion: 'shoedna-tflite-1.4.2',
  brand: 'Nike',
  category: 'athletic_shoes',
  subCategory: 'running_shoes',
  confidence: 0.9234,
  conditionCode: 'C2',
  candidates: [{ brand: 'Nike', model: 'Air Max 90', confidence: 0.9234 }],
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

d('ScanReviewService (integration, real Postgres)', () => {
  let moduleRef: TestingModule;
  let scans: ScanService;
  let results: ScanResultService;
  let reviews: ScanReviewService;
  let ds: DataSource;
  const users: string[] = [];
  const TAG = `rv-${randomUUID().slice(0, 8)}`;
  let nike: CatalogBrandEntity;
  let adidas: CatalogBrandEntity;
  let size75: CatalogSizeEntity;
  let sizeGeneric: CatalogSizeEntity;
  let createdGeneric = false;
  let productWhite: CatalogProductEntity;

  async function newUser(): Promise<string> {
    const id = randomUUID();
    await ds.getRepository(UserEntity).insert({
      id,
      fullName: 'Review IT',
      email: `review-it-${id}@local.test`,
      password: null,
      country: null,
    });
    users.push(id);
    return id;
  }

  /** F1 → F2: every shoe complete and identified; scan in `review`. */
  async function reviewableScan(
    userId: string,
    shoeCount = 1,
    result: SubmitShoeResultDto = RESULT,
  ) {
    let s = await scans.createDraft(userId);
    for (let i = 0; i < shoeCount; i += 1)
      s = await scans.addShoe(userId, s.id);
    const shoeIds = s.shoes.map((x) => x.id);
    for (const shoeId of shoeIds) {
      for (const v of SHOE_VIEWS) {
        await scans.uploadPhoto(userId, s.id, shoeId, v, file, null);
      }
    }
    s = await scans.finish(userId, s.id);
    for (const shoeId of shoeIds) {
      await results.submit(userId, s.id, shoeId, result);
    }
    return { scanId: s.id, shoeIds };
  }

  const scanStatus = async (scanId: string) =>
    (await ds.getRepository(ScanEntity).findOneByOrFail({ id: scanId })).status;
  const shoeStatus = async (shoeId: string) =>
    (await ds.getRepository(ScanShoeEntity).findOneByOrFail({ id: shoeId }))
      .status;
  const entryFor = (scanShoeId: string) =>
    ds.getRepository(ShoeEntity).findOne({ where: { scanShoeId } });
  const feedbackFor = (scanShoeId: string) =>
    ds.getRepository(ShoeFeedbackEntity).find({ where: { scanShoeId } });

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
          ScanEntity,
          ScanShoeEntity,
          ScanPhotoEntity,
          ScanShoeResultEntity,
          ShoeEntity,
          ShoeFeedbackEntity,
          CatalogBrandEntity,
          CatalogCategoryEntity,
          CatalogSizeEntity,
          CatalogProductEntity,
        ]),
      ],
      providers: [
        ScanService,
        ScanResultService,
        ScanResultsBuilder,
        ScanReviewService,
        CatalogService,
        { provide: PhotoStorage, useValue: new FakeStorage() },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              k === 'scan' ? CFG : k === 'catalog' ? CATALOG_CFG : undefined,
          },
        },
      ],
    }).compile();
    scans = moduleRef.get(ScanService);
    results = moduleRef.get(ScanResultService);
    reviews = moduleRef.get(ScanReviewService);
    ds = moduleRef.get(DataSource);

    // Catalog fixture. The predicted brand "Nike" must resolve by slug, so the
    // fixture brand IS "nike" — guarded against collision with a real seed by
    // upserting and remembering whether it existed.
    const brands = ds.getRepository(CatalogBrandEntity);
    nike =
      (await brands.findOne({ where: { slug: 'nike' } })) ??
      (await brands.save(brands.create({ slug: 'nike', name: 'Nike' })));
    adidas = await brands.save(
      brands.create({ slug: `${TAG}-adidas`, name: `${TAG} Adidas` }),
    );
    const sizes = ds.getRepository(CatalogSizeEntity);
    size75 = await sizes.save(
      sizes.create({
        brandId: adidas.id,
        system: 'US',
        label: '7.5',
        sortOrder: 1,
      }),
    );
    const existingGeneric = await sizes.findOne({
      where: { brandId: IsNull(), system: 'US', label: '9' },
    });
    createdGeneric = existingGeneric === null;
    sizeGeneric =
      existingGeneric ??
      (await sizes.save(
        sizes.create({ brandId: null, system: 'US', label: '9', sortOrder: 9 }),
      ));
    const products = ds.getRepository(CatalogProductEntity);
    productWhite = await products.save(
      products.create({
        brandId: adidas.id,
        sku: `${TAG}-W`,
        model: 'Ultraboost 22',
        colour: 'Cloud White/Black',
        size: '7.5',
        msrp: 190,
        gender: 'women',
      }),
    );
    await products.save(
      products.create({
        brandId: adidas.id,
        sku: `${TAG}-B`,
        model: 'Ultraboost 22',
        colour: 'Core Black',
        size: '9',
        msrp: 180,
        gender: 'men',
      }),
    );
  }, 60_000);

  afterAll(async () => {
    if (ds) {
      // feedback rows survive user deletion (userId → null): remove ours by shoe id
      const mine = await ds
        .getRepository(ShoeEntity)
        .find({ where: users.map((userId) => ({ userId })) });
      if (mine.length) {
        await ds
          .getRepository(ShoeFeedbackEntity)
          .delete(mine.map((s) => ({ shoeId: s.id })));
      }
      if (users.length) await ds.getRepository(UserEntity).delete(users);
      await ds
        .getRepository(CatalogProductEntity)
        .delete({ brandId: adidas.id });
      await ds.getRepository(CatalogBrandEntity).delete({ id: adidas.id });
      if (createdGeneric)
        await ds
          .getRepository(CatalogSizeEntity)
          .delete({ id: sizeGeneric.id });
    }
    await moduleRef?.close();
  });

  // ─── gates ───────────────────────────────────────────────────────────────
  it('refuses to review a draft or a shoe without a result', async () => {
    const userId = await newUser();
    const s = await scans.createDraft(userId);
    const shoeId = (await scans.addShoe(userId, s.id)).shoes[0].id;
    expect(await code(reviews.confirm(userId, s.id, shoeId, {}))).toBe(
      'NOT_IN_REVIEW',
    );

    // two shoes, only one with a result: the other one has NO_RESULT, the
    // identified one can be reviewed while the scan is still `processing`
    const { scanId, shoeIds } = await (async () => {
      let sc = await scans.createDraft(userId);
      sc = await scans.addShoe(userId, sc.id);
      sc = await scans.addShoe(userId, sc.id);
      const ids = sc.shoes.map((x) => x.id);
      for (const id of ids)
        for (const v of SHOE_VIEWS)
          await scans.uploadPhoto(userId, sc.id, id, v, file, null);
      sc = await scans.finish(userId, sc.id);
      await results.submit(userId, sc.id, ids[0], RESULT);
      return { scanId: sc.id, shoeIds: ids };
    })();
    expect(await scanStatus(scanId)).toBe('processing');
    expect(await code(reviews.confirm(userId, scanId, shoeIds[1], {}))).toBe(
      'NO_RESULT',
    );
    const view = await reviews.confirm(userId, scanId, shoeIds[0], {});
    expect(view.reviewed).toEqual({ done: 1, total: 2 });
    expect(view.status).toBe('processing');
  });

  it('another user cannot review the scan (404, IDOR)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const { scanId, shoeIds } = await reviewableScan(owner);
    expect(await code(reviews.confirm(other, scanId, shoeIds[0], {}))).toBe(
      'SCAN_NOT_FOUND',
    );
    expect(await code(reviews.confirm(owner, scanId, randomUUID(), {}))).toBe(
      'SHOE_NOT_FOUND',
    );
  });

  // ─── confirm ─────────────────────────────────────────────────────────────
  it('confirm copies the prediction, resolves the brand by slug, writes feedback and placeholders', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await reviewableScan(userId);
    const view = await reviews.confirm(userId, scanId, shoeIds[0], {
      gender: 'women',
    });

    expect(view.status).toBe('completed');
    expect(view.reviewed).toEqual({ done: 1, total: 1 });
    const e = view.shoes[0];
    expect(e.review).toBe('confirmed');
    expect(e.myShoe?.brand).toEqual({ id: nike.id, name: nike.name });
    expect(e.myShoe?.category).toBe('athletic_shoes');
    expect(e.myShoe?.subCategory).toBe('running_shoes');
    expect(e.myShoe?.condition).toEqual({ code: 'C2', label: 'Lightly Worn' });
    expect(e.myShoe?.model).toBeNull();
    expect(e.myShoe?.gender).toBe('women');
    expect(e.myShoe?.valueSource).toBe('static');
    expect(e.myShoe?.recommendedAction).not.toBeNull();
    expect(e.myShoe?.thumbnailUrl).toMatch(/^fake:\/\/scans\/.*\/right-/);
    // the prefill is only computed while a shoe awaits review; afterwards
    // myShoe carries the brand and suggested keeps just the predicted text
    expect(e.suggested).toEqual({ brandId: null, brand: 'Nike' });

    const row = await entryFor(shoeIds[0]);
    expect(row?.userId).toBe(userId);
    expect(row?.primaryPhotoS3Key).toContain('/right-');
    const fb = await feedbackFor(shoeIds[0]);
    expect(fb).toHaveLength(1);
    expect(fb[0].type).toBe('confirmed');
    expect(fb[0].shoeId).toBe(row?.id);
    expect(fb[0].original).toMatchObject({
      brand: 'Nike',
      confidence: 0.9234,
      conditionCode: 'C2',
    });
    expect(fb[0].answer).toMatchObject({
      brandId: nike.id,
      brand: 'Nike',
      gender: 'women',
    });
    expect(await shoeStatus(shoeIds[0])).toBe('confirmed');
    expect(await scanStatus(scanId)).toBe('completed');
  });

  it('confirm with a brandId overrides the predicted brand; unknown ids are 400', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await reviewableScan(userId);
    expect(
      await code(
        reviews.confirm(userId, scanId, shoeIds[0], { brandId: randomUUID() }),
      ),
    ).toBe('UNKNOWN_BRAND');
    expect(
      await code(
        reviews.confirm(userId, scanId, shoeIds[0], { sizeId: randomUUID() }),
      ),
    ).toBe('UNKNOWN_SIZE');
    // a size that belongs to another brand is refused too (PR 13 review);
    // the predicted brand here is Nike, size75 is an Adidas row
    expect(
      await code(
        reviews.confirm(userId, scanId, shoeIds[0], { sizeId: size75.id }),
      ),
    ).toBe('UNKNOWN_SIZE');
    // a generic size is always fine
    const generic = await reviews.confirm(userId, scanId, shoeIds[0], {
      sizeId: sizeGeneric.id,
      model: 'Pegasus 40',
    });
    expect(generic.shoes[0].myShoe?.size.label).toBe('9');
    // product match needs colour or size evidence: model alone → no product
    expect((await entryFor(shoeIds[0]))?.catalogProductId).toBeNull();
    await ds.getRepository(ShoeEntity).delete({ scanShoeId: shoeIds[0] });
    await ds
      .getRepository(ShoeFeedbackEntity)
      .delete({ scanShoeId: shoeIds[0] });
    await ds
      .getRepository(ScanShoeEntity)
      .update({ id: shoeIds[0] }, { status: 'identified' });
    const view = await reviews.confirm(userId, scanId, shoeIds[0], {
      brandId: adidas.id,
      model: 'Ultraboost 22',
      color: 'white',
      sizeId: size75.id,
    });
    const my = view.shoes[0].myShoe!;
    expect(my.brand.id).toBe(adidas.id);
    expect(my.size).toEqual({ id: size75.id, label: '7.5' });
    // silent product match: brand + model, colour "white" + size 7.5 → the white SKU, msrp copied
    const row = await entryFor(shoeIds[0]);
    expect(row?.catalogProductId).toBe(productWhite.id);
    expect(row?.msrp).toBe(190);
  });

  it('confirm on a prediction without a usable brand needs brandId (BRAND_REQUIRED)', async () => {
    const userId = await newUser();
    // ShoeDNA's "Unknown" sentinel behaves like no brand at all
    const unk = await reviewableScan(userId, 1, {
      ...RESULT,
      brand: 'Unknown',
    });
    expect(
      await code(reviews.confirm(userId, unk.scanId, unk.shoeIds[0], {})),
    ).toBe('BRAND_REQUIRED');
    expect(
      (await results.results(userId, unk.scanId)).shoes[0].suggested,
    ).toEqual({ brandId: null, brand: null });
    const { scanId, shoeIds } = await reviewableScan(userId, 1, {
      modelVersion: 'x',
      outcome: 'failed',
      candidates: [],
    });
    expect(await code(reviews.confirm(userId, scanId, shoeIds[0], {}))).toBe(
      'BRAND_REQUIRED',
    );
    const view = await reviews.confirm(userId, scanId, shoeIds[0], {
      brandId: adidas.id,
    });
    expect(view.shoes[0].myShoe?.brand.id).toBe(adidas.id);
    expect(view.shoes[0].myShoe?.condition.code).toBeNull();
  });

  // ─── reject ──────────────────────────────────────────────────────────────
  it('reject builds the entry from the answer, keeps the prediction as corrected feedback', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await reviewableScan(userId);
    expect(
      await code(
        reviews.reject(userId, scanId, shoeIds[0], {
          brandId: adidas.id,
          model: 'Ultraboost 22',
        }),
      ),
    ).toBe('FIELDS_REQUIRED');
    const view = await reviews.reject(userId, scanId, shoeIds[0], {
      brandId: adidas.id,
      model: '  Ultraboost 22 ',
      color: 'Core Black',
      sizeId: sizeGeneric.id,
      gender: 'men',
    });
    const my = view.shoes[0].myShoe!;
    expect(view.shoes[0].review).toBe('rejected');
    expect(my.brand.id).toBe(adidas.id);
    expect(my.model).toBe('Ultraboost 22');
    expect(my.color).toBe('Core Black');
    expect(my.size.label).toBe('9');
    // prediction-only fields still come from F2 (F3-D5, D8)
    expect(my.category).toBe('athletic_shoes');
    expect(my.condition.code).toBe('C2');
    const fb = await feedbackFor(shoeIds[0]);
    expect(fb[0].type).toBe('corrected');
    expect(fb[0].original).toMatchObject({ brand: 'Nike' });
    expect(fb[0].answer).toMatchObject({
      brand: adidas.name,
      model: 'Ultraboost 22',
      size: '9',
    });
    expect(await shoeStatus(shoeIds[0])).toBe('rejected');
    const row = await entryFor(shoeIds[0]);
    expect(row?.msrp).toBe(180); // black / size 9 SKU won the match
  });

  // ─── repeats and completion ──────────────────────────────────────────────
  it('a second review of the same shoe is refused either way; one entry only', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await reviewableScan(userId);
    const first = await reviews.confirm(userId, scanId, shoeIds[0], {});
    const myShoeId = first.shoes[0].myShoeId;
    expect(await code(reviews.confirm(userId, scanId, shoeIds[0], {}))).toBe(
      'ALREADY_REVIEWED',
    );
    try {
      await reviews.reject(userId, scanId, shoeIds[0], {
        brandId: adidas.id,
        model: 'm',
        color: 'c',
        sizeId: size75.id,
      });
      throw new Error('expected ALREADY_REVIEWED');
    } catch (e) {
      expect((e as ApiError).code).toBe('ALREADY_REVIEWED');
      expect((e as ApiError).details).toEqual({
        review: 'confirmed',
        myShoeId,
      });
    }
    expect(
      await ds
        .getRepository(ShoeEntity)
        .count({ where: { scanShoeId: shoeIds[0] } }),
    ).toBe(1);
    expect(await feedbackFor(shoeIds[0])).toHaveLength(1);
  });

  it('the scan completes only when the last shoe is reviewed; parallel reviews both land', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await reviewableScan(userId, 3);
    const v1 = await reviews.confirm(userId, scanId, shoeIds[0], {});
    expect(v1.reviewed).toEqual({ done: 1, total: 3 });
    expect(v1.status).toBe('review');
    expect(await scanStatus(scanId)).toBe('review');

    const [a, b] = await Promise.all([
      reviews.confirm(userId, scanId, shoeIds[1], {}),
      reviews.reject(userId, scanId, shoeIds[2], {
        brandId: adidas.id,
        model: 'x',
        color: 'y',
        sizeId: size75.id,
      }),
    ]);
    expect([a.reviewed.done, b.reviewed.done].sort()).toEqual([2, 3]);
    expect(await scanStatus(scanId)).toBe('completed');
    expect(
      await ds.getRepository(ShoeEntity).count({ where: { userId } }),
    ).toBe(3);
    const view = await results.results(userId, scanId);
    expect(view.reviewed).toEqual({ done: 3, total: 3 });
    expect(view.shoes.map((s) => s.review)).toEqual([
      'confirmed',
      'confirmed',
      'rejected',
    ]);
    expect(view.shoes.every((s) => s.myShoe !== null)).toBe(true);
  });

  it('E11 before any review: review null, myShoe null, suggested prefilled, reviewed 0 of N', async () => {
    const userId = await newUser();
    const { scanId } = await reviewableScan(userId, 2);
    const view = await results.results(userId, scanId);
    expect(view.reviewed).toEqual({ done: 0, total: 2 });
    for (const s of view.shoes) {
      expect(s.review).toBeNull();
      expect(s.myShoe).toBeNull();
      expect(s.suggested.brandId).toBe(nike.id);
    }
  });

  it('F2 refuses to change a result once F3 closed the shoe', async () => {
    const userId = await newUser();
    // two shoes so the scan stays in `review` after one confirm (a completed
    // scan refuses every submit with NOT_PROCESSING, which is F2's own gate)
    const { scanId, shoeIds } = await reviewableScan(userId, 2);
    await reviews.confirm(userId, scanId, shoeIds[0], {});
    expect(await code(results.submit(userId, scanId, shoeIds[0], RESULT))).toBe(
      'RESULT_LOCKED',
    );
  });

  it('placeholders are deterministic per shoe; confirm with a different brand is logged as corrected', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await reviewableScan(userId, 2);
    const view = await reviews.confirm(userId, scanId, shoeIds[0], {});
    const row = (await entryFor(shoeIds[0]))!;
    expect(row.valueComputedAt).not.toBeNull();
    expect(view.shoes[0].myShoe?.resale.currency).toBe('USD');
    // predicted model/colorway carried on a bare confirm (none in RESULT → null)
    expect(row.model).toBeNull();
    // confirm but with another brand → feedback says corrected, subBrand dropped
    await reviews.confirm(userId, scanId, shoeIds[1], { brandId: adidas.id });
    const fb = await feedbackFor(shoeIds[1]);
    expect(fb[0].type).toBe('corrected');
    expect((await entryFor(shoeIds[1]))?.subBrand).toBeNull();
  });
});
