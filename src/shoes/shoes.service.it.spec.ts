// Integration tests for ShoesService (F5) against a real PostgreSQL
// (local-infra, port 5433). F1 + F2 + F3 services drive a scan through review
// so a My Shoes entry exists, then every F5 operation is exercised end to end:
// profile, edit (rematch, action taken), photos (cap, primary promotion, last
// photo), share (create / return / revoke / public view), condition feedback,
// rescan (one open at a time, review updates in place), remove (hidden scan,
// revoked share).
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
import { CatalogShoeTypeEntity } from '../catalog/entities/catalog-shoe-type.entity';
import { CatalogSizeEntity } from '../catalog/entities/catalog-size.entity';
import type { CatalogConfig } from '../config/catalog.config';
import type { ScanConfig } from '../config/scan.config';
import type { ShoesConfig } from '../config/shoes.config';
import { ScanEntity } from '../scan/entities/scan.entity';
import { ScanShoeEntity } from '../scan/entities/scan-shoe.entity';
import { ShoeFeedbackEntity } from '../scan/entities/shoe-feedback.entity';
import { ScanService } from '../scan/scan.service';
import { ScanResultService } from '../scan/scan-result.service';
import { ScanResultsBuilder } from '../scan/scan-results.builder';
import { ScanReviewService } from '../scan/scan-review.service';
import { SHOE_VIEWS } from '../scan/scan.types';
import type { SubmitShoeResultDto } from '../scan/dto/submit-shoe-result.dto';
import { ShoeEntity } from './entities/shoe.entity';
import { ShoePhotoEntity } from './entities/shoe-photo.entity';
import { ShoeShareEntity } from './entities/shoe-share.entity';
import { ShoeViewMapper } from './shoe-view.mapper';
import { ShoesService } from './shoes.service';
import { SHOE_VALUE_PROVIDER } from './value/shoe-value.provider';
import { StaticValueProvider } from './value/static-value.provider';

loadEnv();
const RUN = process.env.SCAN_IT_DB === '1';
const d = RUN ? describe : describe.skip;

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const file = { fieldname: 'file', buffer: PNG, size: PNG.length };
const BASE = 'http://api.test/api/v1';

class FakeStorage extends PhotoStorage {
  deleted: string[] = [];
  isConfigured() {
    return true;
  }
  put() {
    return Promise.resolve();
  }
  delete(key: string) {
    this.deleted.push(key);
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
  inferenceTimeoutMs: 25000,
  valuePlaceholder: true,
  thumbnailView: 'right',
};
const CATALOG_CFG: CatalogConfig = {
  mutedEndpoints: [],
  listMax: 500,
  source: null,
};
const SHOES_CFG: ShoesConfig = {
  maxPhotos: 6,
  photoUrlTtlSeconds: 60,
  shareBaseUrl: null,
  shareTokenRandomChars: 12,
  uploadPrefix: 'shoes',
};

const RESULT: SubmitShoeResultDto = {
  modelVersion: 'shoedna-tflite-1.4.2',
  brand: 'Nike',
  category: 'running_shoes',
  subCategory: 'road_running',
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

d('ShoesService (integration, real Postgres)', () => {
  let moduleRef: TestingModule;
  let scans: ScanService;
  let results: ScanResultService;
  let reviews: ScanReviewService;
  let shoes: ShoesService;
  let ds: DataSource;
  const storage = new FakeStorage();
  const users: string[] = [];
  const TAG = `f5-${randomUUID().slice(0, 8)}`;
  let nike: CatalogBrandEntity;
  let adidas: CatalogBrandEntity;
  let size9: CatalogSizeEntity;
  let productBlack: CatalogProductEntity;
  let boots: CatalogShoeTypeEntity;

  async function newUser(): Promise<string> {
    const id = randomUUID();
    await ds.getRepository(UserEntity).insert({
      id,
      fullName: 'F5 IT',
      email: `f5-it-${id}@local.test`,
      password: null,
      country: null,
    });
    users.push(id);
    return id;
  }

  /** F1 → F2 → F3 confirm: returns the My Shoes id and its scan ids. */
  async function reviewedShoe(
    userId: string,
    scanId?: string,
    shoeId?: string,
  ) {
    let s = scanId
      ? await scans.get(userId, scanId)
      : await scans.createDraft(userId);
    if (!shoeId) s = await scans.addShoe(userId, s.id);
    const scanShoeId = shoeId ?? s.shoes[0].id;
    for (const v of SHOE_VIEWS) {
      await scans.uploadPhoto(userId, s.id, scanShoeId, v, file, null);
    }
    s = await scans.finish(userId, s.id);
    await results.submit(userId, s.id, scanShoeId, RESULT);
    const view = await reviews.confirm(userId, s.id, scanShoeId, {});
    const entry = view.shoes.find((x) => x.shoeId === scanShoeId)!;
    return { myShoeId: entry.myShoeId!, scanId: s.id, scanShoeId };
  }

  const shoeRow = (id: string) =>
    ds.getRepository(ShoeEntity).findOneByOrFail({ id });
  const photosOf = (shoeId: string) =>
    ds.getRepository(ShoePhotoEntity).find({
      where: { shoeId },
      order: { sortOrder: 'ASC' },
    });

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
          CatalogBrandEntity,
          CatalogCategoryEntity,
          CatalogSizeEntity,
          CatalogProductEntity,
          CatalogShoeTypeEntity,
          ShoeEntity,
          ShoePhotoEntity,
          ShoeShareEntity,
          ShoeFeedbackEntity,
        ]),
      ],
      providers: [
        ScanService,
        ScanResultService,
        ScanResultsBuilder,
        ScanReviewService,
        CatalogService,
        ShoesService,
        ShoeViewMapper,
        StaticValueProvider,
        { provide: SHOE_VALUE_PROVIDER, useExisting: StaticValueProvider },
        { provide: PhotoStorage, useValue: storage },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              k === 'scan'
                ? CFG
                : k === 'catalog'
                  ? CATALOG_CFG
                  : k === 'shoes'
                    ? SHOES_CFG
                    : undefined,
          },
        },
      ],
    }).compile();
    ds = moduleRef.get(DataSource);
    scans = moduleRef.get(ScanService);
    results = moduleRef.get(ScanResultService);
    reviews = moduleRef.get(ScanReviewService);
    shoes = moduleRef.get(ShoesService);

    // Catalog fixture (slugs tagged so a parallel run never collides).
    const brands = ds.getRepository(CatalogBrandEntity);
    nike = await brands.save(
      brands.create({ slug: `nike-${TAG}`, name: `Nike ${TAG}` }),
    );
    adidas = await brands.save(
      brands.create({ slug: `adidas-${TAG}`, name: `Adidas ${TAG}` }),
    );
    const sizes = ds.getRepository(CatalogSizeEntity);
    size9 = await sizes.save(
      sizes.create({
        brandId: nike.id,
        system: 'US',
        label: '9',
        sortOrder: 90,
      }),
    );
    const products = ds.getRepository(CatalogProductEntity);
    productBlack = await products.save(
      products.create({
        brandId: nike.id,
        sku: `SKU-${TAG}-BLK`,
        model: 'Air Max 90',
        modelCode: null,
        category: 'athletic',
        subCategory: 'running',
        silhouette: null,
        gender: 'men',
        colour: 'Black / White',
        size: '9',
        sizeRaw: '9',
        msrp: 130,
        releaseDate: null,
        title: 'Nike Air Max 90 Black',
        source: 'test',
        isActive: true,
      }),
    );
    boots = await ds
      .getRepository(CatalogShoeTypeEntity)
      .findOneByOrFail({ slug: 'boots' });
  }, 60000);

  afterAll(async () => {
    if (!ds) return;
    for (const u of users) {
      await scans.deleteAllForUser(u);
      await ds.getRepository(ShoeEntity).delete({ userId: u });
      await ds.getRepository(UserEntity).delete({ id: u });
    }
    await ds
      .getRepository(CatalogProductEntity)
      .delete({ id: productBlack.id });
    await ds.getRepository(CatalogSizeEntity).delete({ id: size9.id });
    await ds.getRepository(CatalogBrandEntity).delete({ id: nike.id });
    await ds.getRepository(CatalogBrandEntity).delete({ id: adidas.id });
    await moduleRef.close();
  });

  // ─── E21 profile ─────────────────────────────────────────────────────────
  it('profile: one call with photos (signed), condition from the mapping, placeholders, no share', async () => {
    const userId = await newUser();
    const { myShoeId, scanId, scanShoeId } = await reviewedShoe(userId);
    const p = await shoes.getProfile(userId, myShoeId, BASE);
    expect(p.id).toBe(myShoeId);
    expect(p.brand.name).toBe('Nike');
    expect(p.photos).toHaveLength(4);
    expect(p.photos.map((x) => x.view)).toEqual([
      'top',
      'right',
      'left',
      'sole',
    ]);
    expect(
      p.photos.every(
        (x) => x.source === 'scan' && x.url?.startsWith('fake://'),
      ),
    ).toBe(true);
    expect(p.photos.find((x) => x.isPrimary)?.view).toBe('right');
    expect(p.condition).toEqual({
      code: 'C2',
      grade: 'A',
      label: 'Lightly Worn',
      description: 'Minor signs of wear, fully functional',
      filterGroup: 'Good',
    });
    expect(p.value.source).toBe('static');
    expect(p.recommendation.action).not.toBeNull();
    expect(p.materials).toHaveLength(4);
    expect(p.circularSort).toEqual({ status: 'pending' });
    expect(p.share).toEqual({ active: false, url: null, createdAt: null });
    expect(p.scan).toEqual({ scanId, scanShoeId });
    expect(p.rescan).toBeNull();
    expect(p.actionTaken).toBe('none');
    // ShoeDNA category "running_shoes" maps onto Athletic Shoes by keyword
    expect(p.shoeType.name).toBe('Athletic Shoes');
    expect(p.conditionFeedback).toBeNull();
    expect((p as unknown as Record<string, unknown>).co2eKg).toBeUndefined();
  });

  it('profile is scoped: another user, a random id and a removed shoe all answer SHOE_NOT_FOUND', async () => {
    const a = await newUser();
    const b = await newUser();
    const { myShoeId } = await reviewedShoe(a);
    expect(await code(shoes.getProfile(b, myShoeId, BASE))).toBe(
      'SHOE_NOT_FOUND',
    );
    expect(await code(shoes.getProfile(a, randomUUID(), BASE))).toBe(
      'SHOE_NOT_FOUND',
    );
    await shoes.remove(a, myShoeId);
    expect(await code(shoes.getProfile(a, myShoeId, BASE))).toBe(
      'SHOE_NOT_FOUND',
    );
  });

  // ─── E22 edit ────────────────────────────────────────────────────────────
  it('edit: identity change rematches the product; action taken stamps and clears; catalog ids checked', async () => {
    const userId = await newUser();
    const { myShoeId } = await reviewedShoe(userId);
    expect(await code(shoes.update(userId, myShoeId, {}, BASE))).toBe(
      'EMPTY_UPDATE',
    );
    expect(
      await code(
        shoes.update(userId, myShoeId, { brandId: randomUUID() }, BASE),
      ),
    ).toBe('UNKNOWN_BRAND');
    expect(
      await code(
        shoes.update(userId, myShoeId, { sizeId: randomUUID() }, BASE),
      ),
    ).toBe('UNKNOWN_SIZE');
    expect(
      await code(
        shoes.update(userId, myShoeId, { shoeTypeId: randomUUID() }, BASE),
      ),
    ).toBe('UNKNOWN_SHOE_TYPE');
    expect(
      await code(
        shoes.update(userId, myShoeId, { primaryPhotoId: randomUUID() }, BASE),
      ),
    ).toBe('UNKNOWN_PHOTO');

    const p = await shoes.update(
      userId,
      myShoeId,
      {
        brandId: nike.id,
        model: 'Air Max 90',
        color: 'Black',
        sizeId: size9.id,
        shoeTypeId: boots.id,
        gender: 'men',
      },
      BASE,
    );
    expect(p.brand).toEqual({ id: nike.id, name: nike.name });
    expect(p.model).toBe('Air Max 90');
    expect(p.size).toEqual({ id: size9.id, label: '9' });
    expect(p.shoeType).toEqual({ id: boots.id, name: 'Boots' });
    expect(p.materials[0].material).toBe('Leather / Nubuck');
    const row = await shoeRow(myShoeId);
    expect(row.catalogProductId).toBe(productBlack.id);
    expect(row.msrp).toBe(130);
    expect(row.conditionCode).toBe('C2'); // never editable

    const a1 = await shoes.update(
      userId,
      myShoeId,
      { actionTaken: 'resold' },
      BASE,
    );
    expect(a1.actionTaken).toBe('resold');
    expect(a1.actionTakenAt).not.toBeNull();
    const a2 = await shoes.update(
      userId,
      myShoeId,
      { actionTaken: 'none' },
      BASE,
    );
    expect(a2.actionTakenAt).toBeNull();
    // size of another brand is rejected
    expect(
      await code(
        shoes.update(
          userId,
          myShoeId,
          { brandId: adidas.id, sizeId: size9.id },
          BASE,
        ),
      ),
    ).toBe('UNKNOWN_SIZE');
    // no feedback rows from edits (F5-D8)
    const fb = await ds
      .getRepository(ShoeFeedbackEntity)
      .find({ where: { shoeId: myShoeId } });
    expect(fb.map((f) => f.type)).toEqual(['confirmed']);
  });

  // ─── E27 / E28 photos ────────────────────────────────────────────────────
  it('photos: upload to the cap, primary promotion on delete, scan photos fixed, uploads removed from storage', async () => {
    const userId = await newUser();
    const { myShoeId } = await reviewedShoe(userId);
    storage.deleted = [];
    let p = await shoes.uploadPhoto(userId, myShoeId, file, BASE);
    expect(p.photos).toHaveLength(5);
    const up1 = p.photos[4];
    expect(up1.source).toBe('upload');
    expect(up1.sortOrder).toBe(4);
    p = await shoes.uploadPhoto(userId, myShoeId, file, BASE);
    expect(p.photos).toHaveLength(6);
    expect(await code(shoes.uploadPhoto(userId, myShoeId, file, BASE))).toBe(
      'PHOTO_LIMIT_REACHED',
    );
    expect(
      await code(shoes.uploadPhoto(userId, myShoeId, undefined, BASE)),
    ).toBe('FILE_REQUIRED');
    const bad = { ...file, buffer: Buffer.from('not an image'), size: 12 };
    expect(await code(shoes.uploadPhoto(userId, myShoeId, bad, BASE))).toBe(
      'UNSUPPORTED_TYPE',
    );
    // a rejected upload left no row behind
    expect(await photosOf(myShoeId)).toHaveLength(6);

    // set the upload as main, then delete it → next lowest sortOrder wins
    p = await shoes.update(userId, myShoeId, { primaryPhotoId: up1.id }, BASE);
    expect(p.photos.find((x) => x.isPrimary)?.id).toBe(up1.id);
    p = await shoes.deletePhoto(userId, myShoeId, up1.id, BASE);
    expect(p.photos).toHaveLength(5);
    expect(p.photos.find((x) => x.isPrimary)?.view).toBe('top');
    expect(
      storage.deleted.some((k) => k.startsWith(`shoes/${userId}/${myShoeId}/`)),
    ).toBe(true);
    // scan photos are fixed: replaced by a rescan, never deleted one by one
    storage.deleted = [];
    const top = p.photos.find((x) => x.view === 'top')!;
    expect(await code(shoes.deletePhoto(userId, myShoeId, top.id, BASE))).toBe(
      'SCAN_PHOTO_FIXED',
    );
    expect(storage.deleted).toEqual([]);
    expect(
      await code(shoes.deletePhoto(userId, myShoeId, randomUUID(), BASE)),
    ).toBe('PHOTO_NOT_FOUND');
    // remaining upload removed → back to the four views
    for (const ph of p.photos.filter((x) => x.source === 'upload')) {
      p = await shoes.deletePhoto(userId, myShoeId, ph.id, BASE);
    }
    expect(p.photos).toHaveLength(4);
    expect(p.photos.every((x) => x.source === 'scan')).toBe(true);
    // the F3 results view still finds a thumbnail through the primary row
    const scanShoe = await ds
      .getRepository(ScanShoeEntity)
      .findOneByOrFail({ id: (await shoeRow(myShoeId)).scanShoeId ?? '' });
    const rv = await results.results(userId, scanShoe.scanId);
    expect(rv.shoes[0].myShoe?.thumbnailUrl).toMatch(/^fake:\/\//);
    expect(rv.shoes[0].myShoe?.primaryPhotoId).toBe(
      p.photos.find((x) => x.isPrimary)!.id,
    );
  });

  it('PR 15: a brand edit keeps the placeholder seed; a foreign size is cleared', async () => {
    const userId = await newUser();
    const { myShoeId } = await reviewedShoe(userId);
    await shoes.update(
      userId,
      myShoeId,
      { brandId: nike.id, sizeId: size9.id },
      BASE,
    );
    const before = await shoeRow(myShoeId);
    await shoes.update(userId, myShoeId, { brandId: adidas.id }, BASE);
    const after = await shoeRow(myShoeId);
    // same seed (scan shoe id) → same placeholder value on a rename
    expect(after.recommendedAction).toBe(before.recommendedAction);
    expect(after.resaleMin).toBe(before.resaleMin);
    expect(after.resaleMax).toBe(before.resaleMax);
    // the Nike size does not belong to Adidas → cleared
    expect(after.sizeId).toBeNull();
    expect(after.size).toBeNull();
  });

  it('PR 15: remove abandons an open rescan draft; a rescan in flight cannot resurrect the pair', async () => {
    const userId = await newUser();
    const a = await reviewedShoe(userId);
    const draft = await shoes.rescan(userId, a.myShoeId);
    await shoes.remove(userId, a.myShoeId);
    expect(
      (await ds.getRepository(ScanEntity).findOneByOrFail({ id: draft.scanId }))
        .status,
    ).toBe('abandoned');

    const b = await reviewedShoe(userId);
    const r = await shoes.rescan(userId, b.myShoeId);
    for (const v of SHOE_VIEWS) {
      await scans.uploadPhoto(userId, r.scanId, r.shoeId, v, file, null);
    }
    await scans.finish(userId, r.scanId);
    await results.submit(userId, r.scanId, r.shoeId, RESULT);
    await shoes.remove(userId, b.myShoeId); // removed while in review
    expect(await code(reviews.confirm(userId, r.scanId, r.shoeId, {}))).toBe(
      'RESCAN_TARGET_REMOVED',
    );
    expect(
      await ds
        .getRepository(ShoeEntity)
        .count({ where: { userId, deletedAt: IsNull() } }),
    ).toBe(0);
  });

  it('PR 15: account purge removes uploaded photos (rows and objects), keeps scan rows', async () => {
    const userId = await newUser();
    const { myShoeId } = await reviewedShoe(userId);
    await shoes.uploadPhoto(userId, myShoeId, file, BASE);
    await shoes.uploadPhoto(userId, myShoeId, file, BASE);
    storage.deleted = [];
    expect(await shoes.deleteAllUploadsForUser(userId)).toBe(2);
    expect(
      storage.deleted.filter((k) => k.startsWith(`shoes/${userId}/`)),
    ).toHaveLength(2);
    const left = await photosOf(myShoeId);
    expect(left).toHaveLength(4);
    expect(left.every((x) => x.source === 'scan')).toBe(true);
  });

  // ─── E24 / E25 / E26 share ───────────────────────────────────────────────
  it('share: create once, return the same, public view until revoked, counts views', async () => {
    const userId = await newUser();
    const { myShoeId } = await reviewedShoe(userId);
    const s1 = await shoes.createShare(userId, myShoeId, BASE);
    expect(s1.created).toBe(true);
    expect(s1.link.url).toBe(`${BASE}/s/${s1.link.token}`);
    expect(s1.link.token).toMatch(/^[a-z0-9-]+-[a-z2-9]{12}$/);
    const s2 = await shoes.createShare(userId, myShoeId, BASE);
    expect(s2.created).toBe(false);
    expect(s2.link.token).toBe(s1.link.token);
    const p = await shoes.getProfile(userId, myShoeId, BASE);
    expect(p.share).toEqual({
      active: true,
      url: s1.link.url,
      createdAt: s1.link.createdAt,
    });

    const pub = await shoes.publicView(s1.link.token);
    expect(pub?.brand).toBe('Nike');
    expect(pub?.condition).toEqual({ grade: 'A', label: 'Lightly Worn' });
    expect(pub?.photoUrl).toMatch(/^fake:\/\//);
    expect(Object.keys(pub!)).not.toContain('userId');
    await new Promise((r) => setTimeout(r, 50)); // fire-and-forget counter
    const share = await ds
      .getRepository(ShoeShareEntity)
      .findOneByOrFail({ token: s1.link.token });
    expect(share.viewCount).toBe(1);

    expect(await shoes.publicView('does-not-exist')).toBeNull();
    expect(await shoes.publicView('BAD TOKEN!')).toBeNull();
    await shoes.revokeShare(userId, myShoeId);
    expect(await shoes.publicView(s1.link.token)).toBeNull();
    await shoes.revokeShare(userId, myShoeId); // idempotent
    const s3 = await shoes.createShare(userId, myShoeId, BASE);
    expect(s3.created).toBe(true);
    expect(s3.link.token).not.toBe(s1.link.token);
    expect(
      await ds
        .getRepository(ShoeShareEntity)
        .count({ where: { shoeId: myShoeId, revokedAt: IsNull() } }),
    ).toBe(1);
  });

  // ─── E30 condition feedback ──────────────────────────────────────────────
  it('condition feedback: stored as a training row, assessment unchanged, latest shown on the profile', async () => {
    const userId = await newUser();
    const { myShoeId } = await reviewedShoe(userId);
    const v = await shoes.suggestCondition(userId, myShoeId, {
      suggestedConditionCode: 'C3',
      reason: 'Heel is worn',
    });
    expect(v.suggestedConditionCode).toBe('C3');
    const row = await shoeRow(myShoeId);
    expect(row.conditionCode).toBe('C2');
    const fb = await ds.getRepository(ShoeFeedbackEntity).find({
      where: { shoeId: myShoeId, type: 'condition_suggested' },
    });
    expect(fb).toHaveLength(1);
    expect(fb[0].original).toEqual({ conditionCode: 'C2' });
    expect(fb[0].answer).toEqual({
      suggestedConditionCode: 'C3',
      reason: 'Heel is worn',
    });
    const p = await shoes.getProfile(userId, myShoeId, BASE);
    expect(p.conditionFeedback?.suggestedConditionCode).toBe('C3');
  });

  // ─── E29 rescan + F3 review of the rescan ────────────────────────────────
  it('rescan: one open draft per shoe, linked to the entry and shown on the profile', async () => {
    const userId = await newUser();
    const { myShoeId } = await reviewedShoe(userId);

    const r1 = await shoes.rescan(userId, myShoeId);
    expect(r1.created).toBe(true);
    expect(r1.status).toBe('draft');
    const r2 = await shoes.rescan(userId, myShoeId);
    expect(r2).toEqual({ ...r1, created: false });
    const p0 = await shoes.getProfile(userId, myShoeId, BASE);
    expect(p0.rescan).toEqual({
      scanId: r1.scanId,
      shoeId: r1.shoeId,
      status: 'draft',
    });
    const linked = await ds
      .getRepository(ScanShoeEntity)
      .findOneByOrFail({ id: r1.shoeId });
    expect(linked.rescanOfShoeId).toBe(myShoeId);
  });

  it('rescan review (confirm) rewrites identity, condition and scan photos; uploads and share survive', async () => {
    const userId = await newUser();
    const { myShoeId, scanId: firstScanId } = await reviewedShoe(userId);
    const up = await shoes.uploadPhoto(userId, myShoeId, file, BASE);
    const uploadId = up.photos.find((x) => x.source === 'upload')!.id;
    const share = await shoes.createShare(userId, myShoeId, BASE);
    const before = await photosOf(myShoeId);
    // user-entered fields that ShoeDNA cannot know (PR 15 review)
    await shoes.update(
      userId,
      myShoeId,
      {
        brandId: nike.id,
        sizeId: size9.id,
        gender: 'women',
        shoeTypeId: boots.id,
      },
      BASE,
    );

    const r = await shoes.rescan(userId, myShoeId);
    for (const v of SHOE_VIEWS) {
      await scans.uploadPhoto(userId, r.scanId, r.shoeId, v, file, null);
    }
    await scans.finish(userId, r.scanId);
    await results.submit(userId, r.scanId, r.shoeId, {
      ...RESULT,
      conditionCode: 'C4',
      category: 'specialty_footwear', // maps to no shoe type → Boots kept
    });
    const view = await reviews.confirm(userId, r.scanId, r.shoeId, {
      model: 'Air Max 90',
    });
    expect(view.status).toBe('completed');
    expect(view.shoes[0].myShoeId).toBe(myShoeId); // same entry, not a new one
    expect(
      await ds
        .getRepository(ShoeEntity)
        .count({ where: { userId, deletedAt: IsNull() } }),
    ).toBe(1);

    const row = await shoeRow(myShoeId);
    expect(row.scanShoeId).toBe(r.shoeId);
    expect(row.conditionCode).toBe('C4');
    expect(row.model).toBe('Air Max 90');
    expect(row.shoeType).toBe('Boots');
    // kept from the Edit screen: not in the confirm body
    expect(row.sizeId).toBe(size9.id);
    expect(row.size).toBe('9');
    expect(row.gender).toBe('women');
    const after = await photosOf(myShoeId);
    expect(after).toHaveLength(5);
    expect(
      after
        .filter((x) => x.source === 'scan')
        .every((x) => !before.some((b) => b.id === x.id)),
    ).toBe(true);
    expect(after.some((x) => x.id === uploadId)).toBe(true);
    expect(after.find((x) => x.id === row.primaryPhotoId)?.view).toBe('right');
    const fb = await ds
      .getRepository(ShoeFeedbackEntity)
      .find({ where: { shoeId: myShoeId }, order: { createdAt: 'ASC' } });
    expect(fb.map((f) => f.type)).toEqual(['confirmed', 'rescanned']);
    expect(
      (fb[1].original as { previous: { conditionCode: string } }).previous
        .conditionCode,
    ).toBe('C2');
    expect(await shoes.publicView(share.link.token)).not.toBeNull();
    const p = await shoes.getProfile(userId, myShoeId, BASE);
    expect(p.rescan).toBeNull();
    expect(p.scan.scanId).toBe(r.scanId);
    // the first session no longer backs a live entry → hidden from lists
    const listed = (await scans.list(userId, undefined, 10, 0)).items.map(
      (x) => x.id,
    );
    expect(listed).toContain(r.scanId);
    expect(listed).not.toContain(firstScanId);
  });

  // ─── E23 remove ──────────────────────────────────────────────────────────
  it('remove: soft delete, share revoked, origin scan hidden from lists, rows and photos kept', async () => {
    const userId = await newUser();
    const { myShoeId, scanId, scanShoeId } = await reviewedShoe(userId);
    const share = await shoes.createShare(userId, myShoeId, BASE);
    storage.deleted = [];
    expect(
      (await scans.list(userId, undefined, 10, 0)).items.map((s) => s.id),
    ).toContain(scanId);
    await shoes.remove(userId, myShoeId);
    expect(await code(shoes.remove(userId, myShoeId))).toBe('SHOE_NOT_FOUND');
    const row = await shoeRow(myShoeId);
    expect(row.deletedAt).not.toBeNull();
    expect(await shoes.publicView(share.link.token)).toBeNull();
    expect(
      (await scans.list(userId, undefined, 10, 0)).items.map((s) => s.id),
    ).not.toContain(scanId);
    expect(
      (await ds.getRepository(ScanEntity).findOneByOrFail({ id: scanId }))
        .hiddenAt,
    ).not.toBeNull();
    expect(storage.deleted).toEqual([]);
    expect(await photosOf(myShoeId)).toHaveLength(4);
    expect(
      await ds
        .getRepository(ShoeFeedbackEntity)
        .count({ where: { scanShoeId } }),
    ).toBe(1);
    // the F3 results view still answers for the scan itself (not hidden from direct reads)
    const rv = await results.results(userId, scanId);
    expect(rv.shoes[0].myShoeId).toBe(myShoeId);
  });

  it('remove never hides a session that still has shoes awaiting review (PR 15)', async () => {
    const userId = await newUser();
    let s = await scans.createDraft(userId);
    s = await scans.addShoe(userId, s.id);
    s = await scans.addShoe(userId, s.id);
    const ids = s.shoes.map((x) => x.id);
    for (const id of ids) {
      for (const v of SHOE_VIEWS)
        await scans.uploadPhoto(userId, s.id, id, v, file, null);
    }
    await scans.finish(userId, s.id);
    for (const id of ids) await results.submit(userId, s.id, id, RESULT);
    const v1 = await reviews.confirm(userId, s.id, ids[0], {});
    const my1 = v1.shoes.find((x) => x.shoeId === ids[0])!.myShoeId!;
    await shoes.remove(userId, my1);
    // shoe 2 is still pending → the session stays listed
    expect(
      (await ds.getRepository(ScanEntity).findOneByOrFail({ id: s.id }))
        .hiddenAt,
    ).toBeNull();
    expect(
      (await scans.list(userId, undefined, 10, 0)).items.map((x) => x.id),
    ).toContain(s.id);
    // reviewing shoe 2 creates a live entry; still visible
    await reviews.confirm(userId, s.id, ids[1], {});
    expect(
      (await ds.getRepository(ScanEntity).findOneByOrFail({ id: s.id }))
        .hiddenAt,
    ).toBeNull();
  });

  it('remove hides the scan only once every entry of that session is gone', async () => {
    const userId = await newUser();
    let s = await scans.createDraft(userId);
    s = await scans.addShoe(userId, s.id);
    s = await scans.addShoe(userId, s.id);
    const ids = s.shoes.map((x) => x.id);
    for (const id of ids) {
      for (const v of SHOE_VIEWS)
        await scans.uploadPhoto(userId, s.id, id, v, file, null);
    }
    await scans.finish(userId, s.id);
    for (const id of ids) await results.submit(userId, s.id, id, RESULT);
    const v1 = await reviews.confirm(userId, s.id, ids[0], {});
    const v2 = await reviews.confirm(userId, s.id, ids[1], {});
    const my1 = v1.shoes.find((x) => x.shoeId === ids[0])!.myShoeId!;
    const my2 = v2.shoes.find((x) => x.shoeId === ids[1])!.myShoeId!;
    await shoes.remove(userId, my1);
    expect(
      (await ds.getRepository(ScanEntity).findOneByOrFail({ id: s.id }))
        .hiddenAt,
    ).toBeNull();
    await shoes.remove(userId, my2);
    expect(
      (await ds.getRepository(ScanEntity).findOneByOrFail({ id: s.id }))
        .hiddenAt,
    ).not.toBeNull();
  });
});
