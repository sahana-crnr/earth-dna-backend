// Integration tests for ShoesListService (F4 + F6) against a real PostgreSQL
// (local-infra, port 5433). `shoes` rows are inserted directly — how F3 creates
// them is covered by scan-review.service.it.spec.ts; here only the reads matter.
//
// Skipped unless SCAN_IT_DB=1, so `npm test` needs no database:
//   npm run db:start && npm run test:scan-it
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { PhotoStorage } from '../storage/photo-storage';
import { UserEntity } from '../user/entities/user.entity';
import type { ScanConfig } from '../config/scan.config';
import { ShoeEntity } from './entities/shoe.entity';
import { ShoePhotoEntity } from './entities/shoe-photo.entity';
import { ShoeViewMapper } from './shoe-view.mapper';
import { ShoesListService } from './shoes-list.service';
import { ListShoesQueryDto } from './dto/list-shoes-query.dto';

loadEnv();
const RUN = process.env.SCAN_IT_DB === '1';
const d = RUN ? describe : describe.skip;

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

const CFG = { photoUrlTtlSeconds: 60 } as ScanConfig;

d('ShoesListService (integration, real Postgres)', () => {
  let moduleRef: TestingModule;
  let svc: ShoesListService;
  let ds: DataSource;
  const users: string[] = [];

  async function newUser(): Promise<string> {
    const id = randomUUID();
    await ds.getRepository(UserEntity).insert({
      id,
      fullName: 'Shoes IT',
      email: `shoes-it-${id}@local.test`,
      password: null,
      country: null,
    });
    users.push(id);
    return id;
  }

  /** One `shoes` row; createdAt is spaced by `ageSec` so order is known. */
  async function shoe(
    userId: string,
    ageSec: number,
    over: Partial<ShoeEntity> = {},
  ): Promise<string> {
    const repo = ds.getRepository(ShoeEntity);
    const row = await repo.save(
      repo.create({
        userId,
        scanShoeId: null,
        brand: 'Nike',
        conditionCode: 'C2',
        recommendedAction: 'resell',
        resaleMin: 65,
        resaleMax: 90,
        resaleBucket: 'from_50_to_100',
        ...over,
      }),
    );
    // F5: the card thumbnail is the primary shoe_photos row
    const photo = await ds.getRepository(ShoePhotoEntity).save(
      ds.getRepository(ShoePhotoEntity).create({
        shoeId: row.id,
        source: 'scan',
        scanPhotoId: null,
        view: 'right',
        s3Key: `scans/x/${randomUUID()}.jpg`,
        sortOrder: 0,
      }),
    );
    await repo.update(row.id, {
      primaryPhotoId: photo.id,
      createdAt: new Date(Date.UTC(2026, 0, 1) - ageSec * 1000),
    });
    return row.id;
  }

  const q = (o: Partial<ListShoesQueryDto> = {}) =>
    Object.assign(new ListShoesQueryDto(), o);
  const ids = async (userId: string, o: Partial<ListShoesQueryDto> = {}) =>
    (await svc.list(userId, q(o))).items.map((i) => i.id);

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
        TypeOrmModule.forFeature([ShoeEntity, ShoePhotoEntity]),
      ],
      providers: [
        ShoesListService,
        ShoeViewMapper,
        { provide: PhotoStorage, useValue: new FakeStorage() },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'scan' ? CFG : undefined) },
        },
      ],
    }).compile();
    svc = moduleRef.get(ShoesListService);
    ds = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    // shoes cascade with the user
    if (ds && users.length) await ds.getRepository(UserEntity).delete(users);
    await moduleRef?.close();
  });

  // ─── E31 list ────────────────────────────────────────────────────────────
  it('lists only my live shoes, newest first, as cards', async () => {
    const me = await newUser();
    const other = await newUser();
    const older = await shoe(me, 20);
    const newer = await shoe(me, 10);
    await shoe(me, 5, { deletedAt: new Date() });
    await shoe(other, 1);

    const page = await svc.list(me, q());
    expect(page.total).toBe(2);
    expect(page.items.map((i) => i.id)).toEqual([newer, older]);
    const card = page.items[0];
    expect(card.condition).toEqual({ code: 'C2', label: 'Lightly Worn' });
    expect(card.actionTaken).toBe('none');
    expect(card.resaleBucket).toBe('from_50_to_100');
    expect(card.resale).toEqual({ min: 65, max: 90, currency: 'USD' });
    expect(card.thumbnailUrl).toMatch(/^fake:\/\/scans\//);
    expect(JSON.stringify(page)).not.toContain('S3Key');
  });

  it('ORs values within a filter and ANDs across filters', async () => {
    const me = await newUser();
    const a = await shoe(me, 4, { conditionCode: 'C1' });
    const b = await shoe(me, 3, { conditionCode: 'C3' });
    const c = await shoe(me, 2, {
      conditionCode: 'C4',
      recommendedAction: 'recycle',
    });
    const e = await shoe(me, 1, {
      conditionCode: 'C5',
      actionTaken: 'recycled',
      resaleBucket: null,
    });

    // heavily_worn covers both C3 and C4
    expect(await ids(me, { condition: ['heavily_worn'] })).toEqual([c, b]);
    expect(await ids(me, { condition: ['like_new', 'not_wearable'] })).toEqual([
      e,
      a,
    ]);
    expect(
      await ids(me, {
        condition: ['heavily_worn'],
        recommendedAction: ['resell'],
      }),
    ).toEqual([b]);
    expect(await ids(me, { actionTaken: ['recycled'] })).toEqual([e]);
    expect(await ids(me, { actionTaken: ['none'] })).toEqual([c, b, a]);
    expect(await ids(me, { resaleBucket: ['from_50_to_100'] })).toEqual([
      c,
      b,
      a,
    ]);
    expect(await ids(me, { resaleBucket: ['over_100'] })).toEqual([]);
  });

  it('pages stably with a total, even when createdAt collides', async () => {
    const me = await newUser();
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push(await shoe(me, 7));
    const seen: string[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const p = await svc.list(me, q({ limit: 2, offset }));
      expect(p.total).toBe(5);
      expect(p.limit).toBe(2);
      expect(p.offset).toBe(offset);
      seen.push(...p.items.map((i) => i.id));
    }
    expect(seen).toEqual([...made].sort().reverse());
  });

  // ─── E32 summary ─────────────────────────────────────────────────────────
  it('is all null for a user with no shoes', async () => {
    const me = await newUser();
    expect(await svc.summary(me)).toEqual({
      pairsScanned: 0,
      potentialValue: null,
    });
  });

  it('sums open pairs for value, every live pair for pairs', async () => {
    const me = await newUser();
    const other = await newUser();
    await shoe(me, 3, { resaleMin: 65, resaleMax: 90 });
    await shoe(me, 2, { resaleMin: 25, resaleMax: 40 });
    // acted on: counted as a pair, not for potential value
    await shoe(me, 1, {
      actionTaken: 'resold',
      resaleMin: 100,
      resaleMax: 200,
    });
    // no value at all
    await shoe(me, 0, {
      resaleMin: null,
      resaleMax: null,
      resaleBucket: null,
    });
    await shoe(me, 0, { deletedAt: new Date() });
    await shoe(other, 0);

    expect(await svc.summary(me)).toEqual({
      pairsScanned: 4,
      potentialValue: { min: 90, max: 130, currency: 'USD' },
    });
    // the header and the list agree
    expect((await svc.list(me, q())).total).toBe(4);
  });

  it('reports a null value when no pair carries one', async () => {
    const me = await newUser();
    await shoe(me, 1, {
      resaleMin: null,
      resaleMax: null,
      resaleBucket: null,
    });
    await shoe(me, 0, { actionTaken: 'donated' });
    expect(await svc.summary(me)).toEqual({
      pairsScanned: 2,
      potentialValue: null,
    });
  });
});
