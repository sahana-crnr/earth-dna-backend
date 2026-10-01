// Integration tests for ScanService against a real PostgreSQL (local-infra,
// port 5433) with an in-memory PhotoStorage fake.
//
// Skipped unless SCAN_IT_DB=1, so `npm test` needs no database:
//   cd ../local-infra && docker compose up -d
//   npm run test:scan-it
//
// P7 (stateful PBT, PBT-06): random command sequences run against the real
// service and a simple model; the observable session must match the model
// after every command. P8: re-uploading a view is idempotent.
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import fc from 'fast-check';
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
import { ScanService } from './scan.service';
import { SHOE_VIEWS, type ShoeView } from './scan.types';
import type { ScanSessionView } from './scan.view';
import type { ScanConfig } from '../config/scan.config';

loadEnv();
const RUN = process.env.SCAN_IT_DB === '1';
const d = RUN ? describe : describe.skip;

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const file = (buffer: Buffer) => ({
  fieldname: 'file',
  buffer,
  size: buffer.length,
});

class FakeStorage extends PhotoStorage {
  objects = new Map<string, Buffer>();
  failPut = false;
  onPut: (() => Promise<void>) | null = null;
  isConfigured() {
    return true;
  }
  async put(key: string, body: Buffer) {
    if (this.failPut) throw new Error('boom');
    if (this.onPut) await this.onPut();
    this.objects.set(key, body);
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

d('ScanService (integration, real Postgres)', () => {
  let moduleRef: TestingModule;
  let service: ScanService;
  let storage: FakeStorage;
  let ds: DataSource;
  const users: string[] = [];

  async function newUser(): Promise<string> {
    const id = randomUUID();
    await ds.getRepository(UserEntity).insert({
      id,
      fullName: 'Scan IT',
      email: `scan-it-${id}@local.test`,
      password: null,
      country: null,
    });
    users.push(id);
    return id;
  }

  /** DB keys for a scan must equal the storage keys under that scan. */
  async function expectStorageMatchesDb(scanId: string) {
    const rows = await ds
      .getRepository(ScanPhotoEntity)
      .createQueryBuilder('p')
      .innerJoin('p.shoe', 's')
      .where('s.scanId = :scanId', { scanId })
      .getMany();
    const dbKeys = rows.map((r) => r.s3Key).sort();
    const stored = [...storage.objects.keys()]
      .filter((k) => k.startsWith(`scans/${scanId}/`))
      .sort();
    expect(stored).toEqual(dbKeys);
  }

  beforeAll(async () => {
    storage = new FakeStorage();
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'localhost',
          port: Number.parseInt(process.env.DB_PORT ?? '5433', 10),
          username: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          entities: [UserEntity, ScanEntity, ScanShoeEntity, ScanPhotoEntity],
          synchronize: false,
          logging: false,
        }),
        TypeOrmModule.forFeature([ScanEntity, ScanShoeEntity, ScanPhotoEntity]),
      ],
      providers: [
        ScanService,
        { provide: PhotoStorage, useValue: storage },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'scan' ? CFG : undefined) },
        },
      ],
    }).compile();
    service = moduleRef.get(ScanService);
    ds = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    if (ds && users.length) {
      await ds.getRepository(UserEntity).delete(users); // cascades to scans
    }
    await moduleRef?.close();
  });

  beforeEach(() => {
    storage.failPut = false;
    storage.onPut = null;
  });

  // ─── P7 stateful model-based test ────────────────────────────────────────
  type Model = {
    shoes: { id: string; views: Set<ShoeView> }[];
    finished: boolean;
  };
  type Real = { userId: string; scanId: string };

  const check = async (m: Model, r: Real, s: ScanSessionView) => {
    expect(s.shoes.map((x) => x.id)).toEqual(m.shoes.map((x) => x.id));
    expect(s.shoes.map((x) => x.position)).toEqual(
      m.shoes.map((_, i) => i + 1),
    );
    s.shoes.forEach((x, i) => {
      expect(x.missing).toEqual(
        SHOE_VIEWS.filter((v) => !m.shoes[i].views.has(v)),
      );
    });
    const modelCanFinish =
      !m.finished &&
      m.shoes.length > 0 &&
      m.shoes.every((x) => x.views.size === 4);
    expect(s.canFinish).toBe(modelCanFinish);
    expect(s.status).toBe(m.finished ? 'processing' : 'draft');
    await expectStorageMatchesDb(r.scanId);
  };

  class AddShoe implements fc.AsyncCommand<Model, Real> {
    check = () => true;
    async run(m: Model, r: Real) {
      const expected = m.finished
        ? 'NOT_DRAFT'
        : m.shoes.length >= CFG.maxShoes
          ? 'SHOE_LIMIT_REACHED'
          : 'OK';
      let s: ScanSessionView | null = null;
      const got = await code(
        service.addShoe(r.userId, r.scanId).then((v) => (s = v)),
      );
      expect(got).toBe(expected);
      if (got === 'OK')
        m.shoes.push({
          id: s!.shoes[s!.shoes.length - 1].id,
          views: new Set(),
        });
      await check(m, r, await service.get(r.userId, r.scanId));
    }
    toString = () => 'AddShoe';
  }

  class Upload implements fc.AsyncCommand<Model, Real> {
    constructor(
      readonly idx: number,
      readonly view: ShoeView,
      readonly jpg: boolean,
    ) {}
    check = (m: Readonly<Model>) => m.shoes.length > 0;
    async run(m: Model, r: Real) {
      const shoe = m.shoes[this.idx % m.shoes.length];
      const got = await code(
        service.uploadPhoto(
          r.userId,
          r.scanId,
          shoe.id,
          this.view,
          file(this.jpg ? JPG : PNG),
          null,
        ),
      );
      expect(got).toBe(m.finished ? 'NOT_DRAFT' : 'OK');
      if (got === 'OK') shoe.views.add(this.view);
      await check(m, r, await service.get(r.userId, r.scanId));
    }
    toString = () =>
      `Upload(${this.idx},${this.view},${this.jpg ? 'jpg' : 'png'})`;
  }

  class DeletePhoto implements fc.AsyncCommand<Model, Real> {
    constructor(
      readonly idx: number,
      readonly view: ShoeView,
    ) {}
    check = (m: Readonly<Model>) => m.shoes.length > 0;
    async run(m: Model, r: Real) {
      const shoe = m.shoes[this.idx % m.shoes.length];
      const expected = m.finished
        ? 'NOT_DRAFT'
        : shoe.views.has(this.view)
          ? 'OK'
          : 'PHOTO_NOT_FOUND';
      expect(
        await code(service.deletePhoto(r.userId, r.scanId, shoe.id, this.view)),
      ).toBe(expected);
      if (expected === 'OK') shoe.views.delete(this.view);
      await check(m, r, await service.get(r.userId, r.scanId));
    }
    toString = () => `DeletePhoto(${this.idx},${this.view})`;
  }

  class DeleteShoe implements fc.AsyncCommand<Model, Real> {
    constructor(readonly idx: number) {}
    check = (m: Readonly<Model>) => m.shoes.length > 0;
    async run(m: Model, r: Real) {
      const i = this.idx % m.shoes.length;
      const expected = m.finished ? 'NOT_DRAFT' : 'OK';
      expect(
        await code(service.deleteShoe(r.userId, r.scanId, m.shoes[i].id)),
      ).toBe(expected);
      if (expected === 'OK') m.shoes.splice(i, 1);
      await check(m, r, await service.get(r.userId, r.scanId));
    }
    toString = () => `DeleteShoe(${this.idx})`;
  }

  class Finish implements fc.AsyncCommand<Model, Real> {
    check = () => true;
    async run(m: Model, r: Real) {
      const expected = m.finished
        ? 'NOT_DRAFT'
        : m.shoes.length === 0
          ? 'NO_SHOES'
          : m.shoes.every((x) => x.views.size === 4)
            ? 'OK'
            : 'SCAN_INCOMPLETE';
      expect(await code(service.finish(r.userId, r.scanId))).toBe(expected);
      if (expected === 'OK') m.finished = true;
      await check(m, r, await service.get(r.userId, r.scanId));
    }
    toString = () => 'Finish';
  }

  it('P7: session state always matches the model (stateful PBT)', async () => {
    const userId = await newUser();
    const view = fc.constantFrom(...SHOE_VIEWS);
    const idx = fc.nat({ max: 5 });
    const commands = fc.commands(
      [
        fc.constant(new AddShoe()),
        fc
          .tuple(idx, view, fc.boolean())
          .map(([i, v, j]) => new Upload(i, v, j)),
        fc.tuple(idx, view).map(([i, v]) => new DeletePhoto(i, v)),
        idx.map((i) => new DeleteShoe(i)),
        fc.constant(new Finish()),
      ],
      { maxCommands: 30 },
    );
    await fc.assert(
      fc.asyncProperty(commands, async (cmds) => {
        const s = await service.createDraft(userId);
        await fc.asyncModelRun(
          () => ({
            model: { shoes: [], finished: false },
            real: { userId, scanId: s.id },
          }),
          cmds,
        );
      }),
      { numRuns: 25 },
    );
  }, 300_000);

  // ─── P8 + example cases ──────────────────────────────────────────────────
  it('P8: uploading the same view twice leaves one photo and one object', async () => {
    const userId = await newUser();
    const s = await service.createDraft(userId);
    const shoeId = (await service.addShoe(userId, s.id)).shoes[0].id;
    await service.uploadPhoto(userId, s.id, shoeId, 'top', file(PNG), null);
    const again = await service.uploadPhoto(
      userId,
      s.id,
      shoeId,
      'top',
      file(PNG),
      null,
    );
    expect(again.shoes[0].photos.filter((p) => p.view === 'top')).toHaveLength(
      1,
    );
    await expectStorageMatchesDb(s.id);
  });

  it('another user cannot see or change the scan (404, IDOR)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const s = await service.createDraft(owner);
    const shoeId = (await service.addShoe(owner, s.id)).shoes[0].id;
    expect(await code(service.get(other, s.id))).toBe('SCAN_NOT_FOUND');
    expect(await code(service.addShoe(other, s.id))).toBe('SCAN_NOT_FOUND');
    expect(await code(service.deleteShoe(other, s.id, shoeId))).toBe(
      'SCAN_NOT_FOUND',
    );
    expect(
      await code(
        service.uploadPhoto(other, s.id, shoeId, 'top', file(PNG), null),
      ),
    ).toBe('SCAN_NOT_FOUND');
    expect(await code(service.finish(other, s.id))).toBe('SCAN_NOT_FOUND');
    expect(
      (await service.list(other, undefined, 20, 0)).items.find(
        (i) => i.id === s.id,
      ),
    ).toBeUndefined();
  });

  it('rejects bad files before touching storage', async () => {
    const userId = await newUser();
    const s = await service.createDraft(userId);
    const shoeId = (await service.addShoe(userId, s.id)).shoes[0].id;
    const before = storage.objects.size;
    expect(
      await code(
        service.uploadPhoto(userId, s.id, shoeId, 'top', undefined, null),
      ),
    ).toBe('FILE_REQUIRED');
    expect(
      await code(
        service.uploadPhoto(
          userId,
          s.id,
          shoeId,
          'top',
          file(Buffer.from('GIF89a')),
          null,
        ),
      ),
    ).toBe('UNSUPPORTED_TYPE');
    const big = Buffer.concat([PNG, Buffer.alloc(CFG.photoMaxBytes)]);
    expect(
      await code(
        service.uploadPhoto(userId, s.id, shoeId, 'top', file(big), null),
      ),
    ).toBe('FILE_TOO_LARGE');
    expect(storage.objects.size).toBe(before);
  });

  it('storage failure → STORAGE_UNAVAILABLE and no photo row', async () => {
    const userId = await newUser();
    const s = await service.createDraft(userId);
    const shoeId = (await service.addShoe(userId, s.id)).shoes[0].id;
    storage.failPut = true;
    expect(
      await code(
        service.uploadPhoto(userId, s.id, shoeId, 'top', file(PNG), null),
      ),
    ).toBe('STORAGE_UNAVAILABLE');
    storage.failPut = false;
    expect((await service.get(userId, s.id)).shoes[0].photos).toHaveLength(0);
  });

  it('compensation: if the scan is finished while uploading, the new object is removed', async () => {
    const userId = await newUser();
    const s = await service.createDraft(userId);
    const shoeId = (await service.addShoe(userId, s.id)).shoes[0].id;
    storage.onPut = async () => {
      await ds
        .getRepository(ScanEntity)
        .update({ id: s.id }, { status: 'processing' });
    };
    expect(
      await code(
        service.uploadPhoto(userId, s.id, shoeId, 'top', file(PNG), null),
      ),
    ).toBe('NOT_DRAFT');
    storage.onPut = null;
    await expectStorageMatchesDb(s.id);
  });

  it('retake with a different type replaces the object key', async () => {
    const userId = await newUser();
    const s = await service.createDraft(userId);
    const shoeId = (await service.addShoe(userId, s.id)).shoes[0].id;
    await service.uploadPhoto(userId, s.id, shoeId, 'top', file(PNG), null);
    const v = await service.uploadPhoto(
      userId,
      s.id,
      shoeId,
      'top',
      file(JPG),
      null,
    );
    expect(v.shoes[0].photos[0].contentType).toBe('image/jpeg');
    await expectStorageMatchesDb(s.id);
  });

  it('album batch: partial success, capacity, source=album', async () => {
    const userId = await newUser();
    const s = await service.createDraft(userId);
    await service.addShoe(userId, s.id);
    await service.addShoe(userId, s.id);
    await service.addShoe(userId, s.id); // 3 of 4 used → capacity 1
    const parts = ['a1', 'a2', 'b1', 'c1', 'c2'].map((f) => ({
      fieldname: f,
      buffer: PNG,
      size: PNG.length,
    }));
    const res = await service.albumBatch(
      userId,
      s.id,
      [
        {
          ref: 'dup',
          files: [
            { field: 'a1', view: 'top' },
            { field: 'a2', view: 'top' },
          ],
        },
        { ref: 'ok', files: [{ field: 'b1', view: 'top' }] },
        {
          ref: 'full',
          files: [
            { field: 'c1', view: 'top' },
            { field: 'c2', view: 'right' },
          ],
        },
      ],
      parts,
    );
    expect(
      res.results.map((r) => [r.ref, r.saved, r.error ?? r.label]),
    ).toEqual([
      ['dup', false, 'DUPLICATE_VIEW'],
      ['ok', true, 'Shoe 04'],
      ['full', false, 'SHOE_LIMIT_REACHED'],
    ]);
    expect(res.session.source).toBe('album');
    await expectStorageMatchesDb(s.id);
    expect(
      await code(
        service.albumBatch(
          userId,
          s.id,
          [1, 2, 3, 4].map((i) => ({
            ref: `r${i}`,
            files: [{ field: `x${i}`, view: 'top' }],
          })),
          [],
        ),
      ),
    ).toBe('BATCH_TOO_LARGE');
  });

  it('PR#11-1: parallel uploads of the same view leave one row and one object', async () => {
    const userId = await newUser();
    const s = await service.createDraft(userId);
    const shoeId = (await service.addShoe(userId, s.id)).shoes[0].id;
    const codes = await Promise.all(
      [1, 2, 3, 4].map(() =>
        code(service.uploadPhoto(userId, s.id, shoeId, 'top', file(PNG), null)),
      ),
    );
    expect(codes).toEqual(['OK', 'OK', 'OK', 'OK']);
    const v = await service.get(userId, s.id);
    expect(v.shoes[0].photos.filter((p) => p.view === 'top')).toHaveLength(1);
    await expectStorageMatchesDb(s.id);
    expect(
      [...storage.objects.keys()].filter((k) => k.startsWith(`scans/${s.id}/`)),
    ).toHaveLength(1);
  });

  it('PR#11-5: open-draft limit holds under parallel creates', async () => {
    const userId = await newUser();
    const limited = new ScanService(ds.getRepository(ScanEntity), ds, storage, {
      get: (k: string) =>
        k === 'scan' ? { ...CFG, maxOpenDrafts: 1 } : undefined,
    } as ConfigService);
    const codes = await Promise.all(
      [1, 2, 3, 4, 5].map(() => code(limited.createDraft(userId))),
    );
    expect(codes.filter((c) => c === 'OK')).toHaveLength(1);
    expect(codes.filter((c) => c === 'DRAFT_LIMIT_REACHED')).toHaveLength(4);
  });

  it('PR#11-3: abandoning a draft removes its photo rows and objects', async () => {
    const userId = await newUser();
    const s = await service.createDraft(userId);
    const shoeId = (await service.addShoe(userId, s.id)).shoes[0].id;
    await service.uploadPhoto(userId, s.id, shoeId, 'top', file(PNG), null);
    await service.uploadPhoto(userId, s.id, shoeId, 'sole', file(JPG), null);
    expect(
      [...storage.objects.keys()].filter((k) => k.startsWith(`scans/${s.id}/`)),
    ).toHaveLength(2);
    await ds.query(
      `UPDATE scans SET "updatedAt" = now() - interval '31 days' WHERE id = $1`,
      [s.id],
    );
    await service.abandonStaleDrafts();
    expect((await service.get(userId, s.id)).status).toBe('abandoned');
    expect((await service.get(userId, s.id)).shoes[0].photos).toHaveLength(0);
    expect(
      [...storage.objects.keys()].filter((k) => k.startsWith(`scans/${s.id}/`)),
    ).toHaveLength(0);
  });

  it('PR#11-3: deleteAllForUser removes scans and objects', async () => {
    const userId = await newUser();
    const s = await service.createDraft(userId);
    const shoeId = (await service.addShoe(userId, s.id)).shoes[0].id;
    await service.uploadPhoto(userId, s.id, shoeId, 'top', file(PNG), null);
    expect(await service.deleteAllForUser(userId)).toBe(1);
    expect(await code(service.get(userId, s.id))).toBe('SCAN_NOT_FOUND');
    expect(
      [...storage.objects.keys()].filter((k) => k.startsWith(`scans/${s.id}/`)),
    ).toHaveLength(0);
  });

  it('abandonStaleDrafts marks only idle drafts', async () => {
    const userId = await newUser();
    const stale = await service.createDraft(userId);
    const fresh = await service.createDraft(userId);
    await ds.query(
      `UPDATE scans SET "updatedAt" = now() - interval '31 days' WHERE id = $1`,
      [stale.id],
    );
    expect(await service.abandonStaleDrafts()).toBeGreaterThanOrEqual(1);
    expect((await service.get(userId, stale.id)).status).toBe('abandoned');
    expect((await service.get(userId, fresh.id)).status).toBe('draft');
    expect(await code(service.addShoe(userId, stale.id))).toBe('NOT_DRAFT');
  });
});
