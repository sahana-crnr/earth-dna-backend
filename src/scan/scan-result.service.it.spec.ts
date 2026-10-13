// Integration tests for ScanResultService (F2) against a real PostgreSQL
// (local-infra, port 5433). ScanService + an in-memory PhotoStorage fake drive
// a scan through F1 so each test starts from a genuinely finished session.
//
// Skipped unless SCAN_IT_DB=1, so `npm test` needs no database:
//   cd ../local-infra && docker compose up -d
//   npm run test:scan-it
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../common/errors/api-error';
import { PhotoStorage } from '../storage/photo-storage';
import { UserEntity } from '../user/entities/user.entity';
import { ScanEntity } from './entities/scan.entity';
import { ScanPhotoEntity } from './entities/scan-photo.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { ScanShoeResultEntity } from './entities/scan-shoe-result.entity';
import { ScanService } from './scan.service';
import { ScanResultService } from './scan-result.service';
import { ScanResultsBuilder } from './scan-results.builder';
import { ShoeViewMapper } from '../shoes/shoe-view.mapper';
import { CatalogService } from '../catalog/catalog.service';
import { CatalogBrandEntity } from '../catalog/entities/catalog-brand.entity';
import { CatalogCategoryEntity } from '../catalog/entities/catalog-category.entity';
import { CatalogProductEntity } from '../catalog/entities/catalog-product.entity';
import { CatalogShoeTypeEntity } from '../catalog/entities/catalog-shoe-type.entity';
import { CatalogSizeEntity } from '../catalog/entities/catalog-size.entity';
import type { CatalogConfig } from '../config/catalog.config';
import { SHOE_VIEWS } from './scan.types';
import type { SubmitShoeResultDto } from './dto/submit-shoe-result.dto';
import type { ScanConfig } from '../config/scan.config';

loadEnv();
const RUN = process.env.SCAN_IT_DB === '1';
const d = RUN ? describe : describe.skip;

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const file = { fieldname: 'file', buffer: PNG, size: PNG.length };

class FakeStorage extends PhotoStorage {
  objects = new Map<string, Buffer>();
  isConfigured() {
    return true;
  }
  put(key: string, body: Buffer) {
    this.objects.set(key, body);
    return Promise.resolve();
  }
  delete(key: string) {
    this.objects.delete(key);
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
  // Small on purpose, so the oversize-blob test stays cheap.
  resultRawMaxBytes: 200,
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
  confidence: 0.9234,
  conditionCode: 'C2',
  candidates: [
    { brand: 'Adidas', model: 'Gazelle', confidence: 0.0256 },
    { brand: 'Nike', model: 'Air Max 90', confidence: 0.9234 },
    { brand: 'Nike', model: 'Air Max 95', confidence: 0.051 },
  ],
  raw: { embeddingVersion: 'v3' },
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

d('ScanResultService (integration, real Postgres)', () => {
  let moduleRef: TestingModule;
  let scans: ScanService;
  let results: ScanResultService;
  let ds: DataSource;
  const users: string[] = [];

  async function newUser(): Promise<string> {
    const id = randomUUID();
    await ds.getRepository(UserEntity).insert({
      id,
      fullName: 'Result IT',
      email: `result-it-${id}@local.test`,
      password: null,
      country: null,
    });
    users.push(id);
    return id;
  }

  /** A scan driven all the way through F1: every shoe complete, status processing. */
  async function finishedScan(userId: string, shoeCount = 1) {
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
    expect(s.status).toBe('processing');
    return { scanId: s.id, shoeIds };
  }

  const rowsFor = (shoeId: string) =>
    ds
      .getRepository(ScanShoeResultEntity)
      .count({ where: { scanShoeId: shoeId } });

  const scanStatus = async (scanId: string) =>
    (await ds.getRepository(ScanEntity).findOneByOrFail({ id: scanId })).status;

  const shoeStatus = async (shoeId: string) =>
    (await ds.getRepository(ScanShoeEntity).findOneByOrFail({ id: shoeId }))
      .status;

  beforeAll(async () => {
    const storage = new FakeStorage();
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'localhost',
          port: Number.parseInt(process.env.DB_PORT ?? '5433', 10),
          username: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          // Every entity: ScanShoeEntity now links to ShoeEntity, which links to
          // the catalog, so a hand-picked list would miss metadata.
          entities: [__dirname + '/../**/*.entity{.ts,.js}'],
          synchronize: false,
          logging: false,
        }),
        TypeOrmModule.forFeature([
          CatalogShoeTypeEntity,
          ScanEntity,
          ScanShoeEntity,
          ScanPhotoEntity,
          ScanShoeResultEntity,
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
        ShoeViewMapper,
        CatalogService,
        { provide: PhotoStorage, useValue: storage },
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
    ds = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    if (ds && users.length) {
      await ds.getRepository(UserEntity).delete(users); // cascades to scans
    }
    await moduleRef?.close();
  });

  // ─── the state gate ──────────────────────────────────────────────────────
  it('refuses a result until the scan is finished', async () => {
    const userId = await newUser();
    const s = await scans.createDraft(userId);
    const shoeId = (await scans.addShoe(userId, s.id)).shoes[0].id;
    expect(await code(results.submit(userId, s.id, shoeId, RESULT))).toBe(
      'NOT_PROCESSING',
    );
  });

  it.each(['completed', 'abandoned'] as const)(
    'refuses a result on a %s scan',
    async (status) => {
      const userId = await newUser();
      const { scanId, shoeIds } = await finishedScan(userId);
      await ds.getRepository(ScanEntity).update(scanId, { status });
      expect(
        await code(results.submit(userId, scanId, shoeIds[0], RESULT)),
      ).toBe('NOT_PROCESSING');
    },
  );

  it('refuses to change a result F3 has already closed', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);
    await results.submit(userId, scanId, shoeIds[0], RESULT);
    await ds
      .getRepository(ScanShoeEntity)
      .update(shoeIds[0], { status: 'confirmed' });
    expect(await code(results.submit(userId, scanId, shoeIds[0], RESULT))).toBe(
      'RESULT_LOCKED',
    );
  });

  // ─── the idempotency contract (F2-D1) ────────────────────────────────────
  it('stores the result against the shoe and records source=device', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);

    const view = await results.submit(userId, scanId, shoeIds[0], RESULT);
    expect(view.replaced).toBe(false);
    expect(view.status).toBe('identified');
    expect(view.result.source).toBe('device');
    expect(view.result.modelVersion).toBe('shoedna-tflite-1.4.2');
    expect(view.result.confidence).toBe(0.9234);
    expect(view.result.matchPercent).toBe(92);
    expect(view.result.condition).toEqual({
      code: 'C2',
      label: 'Lightly Worn',
    });
    expect(view.result.raw).toEqual({ embeddingVersion: 'v3' });
    expect(await shoeStatus(shoeIds[0])).toBe('identified');
  });

  it('re-submitting the identical payload replaces in place, leaving one row', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);

    const first = await results.submit(userId, scanId, shoeIds[0], RESULT);
    const second = await results.submit(userId, scanId, shoeIds[0], RESULT);

    expect(first.replaced).toBe(false);
    expect(second.replaced).toBe(true);
    expect(await rowsFor(shoeIds[0])).toBe(1);
    // A retry after a timeout must be a true no-op for everything the app reads.
    expect(second.result.candidates).toEqual(first.result.candidates);
    expect(second.result.brand).toBe(first.result.brand);
    expect(second.result.confidence).toBe(first.result.confidence);
  });

  it('a later submit with different values overwrites, still one row', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);
    await results.submit(userId, scanId, shoeIds[0], RESULT);

    const view = await results.submit(userId, scanId, shoeIds[0], {
      modelVersion: 'shoedna-tflite-2.0.0',
      brand: 'Adidas',
      confidence: 0.5,
    });
    expect(view.replaced).toBe(true);
    expect(view.result.brand).toBe('Adidas');
    // fields absent from the new payload are cleared, not merged in
    expect(view.result.condition).toEqual({ code: null, label: null });
    expect(view.result.candidates).toEqual([]);
    expect(await rowsFor(shoeIds[0])).toBe(1);
  });

  it('stores candidates in a canonical order, whatever order they arrive in', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);
    const view = await results.submit(userId, scanId, shoeIds[0], RESULT);
    expect(view.result.candidates).toEqual([
      { brand: 'Nike', model: 'Air Max 90', confidence: 0.9234 },
      { brand: 'Nike', model: 'Air Max 95', confidence: 0.051 },
      { brand: 'Adidas', model: 'Gazelle', confidence: 0.0256 },
    ]);
  });

  // ─── processing → review ─────────────────────────────────────────────────
  it('moves the scan to review only once every shoe has a result', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId, 3);

    const a = await results.submit(userId, scanId, shoeIds[0], RESULT);
    expect(a.scanStatus).toBe('processing');
    const b = await results.submit(userId, scanId, shoeIds[1], RESULT);
    expect(b.scanStatus).toBe('processing');
    const c = await results.submit(userId, scanId, shoeIds[2], RESULT);
    expect(c.scanStatus).toBe('review');
    expect(await scanStatus(scanId)).toBe('review');

    // Still accepted afterwards, and still 'review'.
    const again = await results.submit(userId, scanId, shoeIds[0], RESULT);
    expect(again.scanStatus).toBe('review');
    expect(await scanStatus(scanId)).toBe('review');
  });

  it('parallel submits for different shoes still flip the scan to review', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId, 3);
    await Promise.all(
      shoeIds.map((id) => results.submit(userId, scanId, id, RESULT)),
    );
    // Without the row lock each submit could read "someone is still missing".
    expect(await scanStatus(scanId)).toBe('review');
  });

  it('parallel submits for the SAME shoe leave exactly one row', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);
    await Promise.all([
      results.submit(userId, scanId, shoeIds[0], RESULT),
      results.submit(userId, scanId, shoeIds[0], RESULT),
    ]);
    expect(await rowsFor(shoeIds[0])).toBe(1);
  });

  // ─── failed identification ───────────────────────────────────────────────
  it('accepts a failed result without brand or confidence', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);
    const view = await results.submit(userId, scanId, shoeIds[0], {
      modelVersion: 'shoedna-tflite-1.4.2',
      outcome: 'failed',
    });
    expect(view.status).toBe('failed');
    expect(view.result.brand).toBeNull();
    expect(await shoeStatus(shoeIds[0])).toBe('failed');
    // A failed shoe still counts as resolved: the screen must stop spinning.
    expect(view.scanStatus).toBe('review');
  });

  it('rejects an identified result missing brand or confidence', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);
    expect(
      await code(
        results.submit(userId, scanId, shoeIds[0], {
          modelVersion: 'm1',
          brand: 'Nike',
        }),
      ),
    ).toBe('RESULT_INCOMPLETE');
    expect(
      await code(
        results.submit(userId, scanId, shoeIds[0], {
          modelVersion: 'm1',
          confidence: 0.5,
        }),
      ),
    ).toBe('RESULT_INCOMPLETE');
  });

  // ─── configured caps ─────────────────────────────────────────────────────
  it('enforces the configured candidate cap and raw size', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);
    expect(
      await code(
        results.submit(userId, scanId, shoeIds[0], {
          ...RESULT,
          candidates: [
            ...RESULT.candidates!,
            { brand: 'Puma', confidence: 0.1 },
          ],
        }),
      ),
    ).toBe('TOO_MANY_CANDIDATES');
    expect(
      await code(
        results.submit(userId, scanId, shoeIds[0], {
          ...RESULT,
          raw: { blob: 'x'.repeat(CFG.resultRawMaxBytes) },
        }),
      ),
    ).toBe('RAW_TOO_LARGE');
    // A rejected submit stores nothing.
    expect(await rowsFor(shoeIds[0])).toBe(0);
  });

  // ─── reads ───────────────────────────────────────────────────────────────
  it('GET results reports waiting before and the stored result after', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId, 2);

    const before = await results.results(userId, scanId);
    expect(before.status).toBe('processing');
    expect(before.allResolved).toBe(false);
    expect(before.shoes.map((s) => s.status)).toEqual(['waiting', 'waiting']);
    expect(before.shoes.map((s) => s.label)).toEqual(['Shoe 01', 'Shoe 02']);
    expect(before.shoes.every((s) => s.result === null)).toBe(true);

    await results.submit(userId, scanId, shoeIds[0], RESULT);
    const mid = await results.results(userId, scanId);
    expect(mid.allResolved).toBe(false);
    expect(mid.shoes.map((s) => s.status)).toEqual(['identified', 'waiting']);
    expect(mid.shoes[0].result?.brand).toBe('Nike');
    expect(mid.shoes[0].result?.matchPercent).toBe(92);

    await results.submit(userId, scanId, shoeIds[1], RESULT);
    const after = await results.results(userId, scanId);
    expect(after.status).toBe('review');
    expect(after.allResolved).toBe(true);
  });

  // E11 is polled every couple of seconds; `raw` is up to 8 KB per shoe, so it
  // is opt-in there while E10 always returns it.
  it('GET results omits raw unless asked, E10 always returns it', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId, 1);

    const submitted = await results.submit(userId, scanId, shoeIds[0], RESULT);
    expect(submitted.result.raw).toEqual({ embeddingVersion: 'v3' });

    const polled = await results.results(userId, scanId);
    expect(polled.shoes[0].result).not.toHaveProperty('raw');
    // everything the processing screen actually renders is still there
    expect(polled.shoes[0].result?.brand).toBe('Nike');
    expect(polled.shoes[0].result?.matchPercent).toBe(92);

    const withRaw = await results.results(userId, scanId, true);
    expect(withRaw.shoes[0].result?.raw).toEqual({ embeddingVersion: 'v3' });
  });

  it('GET results on a scan with no shoes is not "resolved"', async () => {
    const userId = await newUser();
    const s = await scans.createDraft(userId);
    const view = await results.results(userId, s.id);
    expect(view.shoes).toEqual([]);
    expect(view.allResolved).toBe(false);
  });

  // ─── ownership ───────────────────────────────────────────────────────────
  it('another user can neither read nor write the results (404, IDOR)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const { scanId, shoeIds } = await finishedScan(owner);

    expect(await code(results.results(other, scanId))).toBe('SCAN_NOT_FOUND');
    expect(await code(results.submit(other, scanId, shoeIds[0], RESULT))).toBe(
      'SCAN_NOT_FOUND',
    );

    // A shoe from someone else's scan is a 404 too, not a 403.
    const theirs = await finishedScan(other);
    expect(
      await code(results.submit(owner, scanId, theirs.shoeIds[0], RESULT)),
    ).toBe('SHOE_NOT_FOUND');
  });

  // ─── lifecycle ───────────────────────────────────────────────────────────
  it('deleting the scan takes its results with it', async () => {
    const userId = await newUser();
    const { scanId, shoeIds } = await finishedScan(userId);
    await results.submit(userId, scanId, shoeIds[0], RESULT);
    expect(await rowsFor(shoeIds[0])).toBe(1);

    await ds.getRepository(ScanEntity).delete({ id: scanId });
    expect(await rowsFor(shoeIds[0])).toBe(0);
  });
});
