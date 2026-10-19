// Integration tests for IntegrationsService (F7) against a real PostgreSQL
// (local-infra, port 5433), migrated. Covers what only the database can show:
// the seeded rows, the row lock + partial merge, the CHECK backing
// INTEGRATION_INCOMPLETE, and updatedBy surviving as SET NULL.
//
// Skipped unless SCAN_IT_DB=1, so `npm test` needs no database:
//   npm run db:start && npm run migration:run && npm run test:scan-it
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { UserEntity } from '../user/entities/user.entity';
import { ApiError } from '../common/errors/api-error';
import { IntegrationEntity } from './entities/integration.entity';
import { IntegrationsService } from './integrations.service';
import { INTEGRATION_NAMES } from './integration.types';

loadEnv();
const RUN = process.env.SCAN_IT_DB === '1';
const d = RUN ? describe : describe.skip;

d('IntegrationsService (integration, real Postgres)', () => {
  let moduleRef: TestingModule;
  let svc: IntegrationsService;
  let ds: DataSource;
  let saved: IntegrationEntity[] = [];
  const users: string[] = [];

  async function newAdmin(): Promise<string> {
    const id = randomUUID();
    await ds.getRepository(UserEntity).insert({
      id,
      fullName: 'Integrations IT',
      email: `integrations-it-${id}@local.test`,
      password: null,
      country: null,
    });
    users.push(id);
    return id;
  }

  const code = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => (e instanceof ApiError ? e.code : e),
    );

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
      ],
      providers: [IntegrationsService],
    }).compile();
    svc = moduleRef.get(IntegrationsService);
    ds = moduleRef.get(DataSource);
    // These rows are shared state; put them back afterwards.
    saved = await ds.getRepository(IntegrationEntity).find();
  });

  beforeEach(async () => {
    await ds
      .getRepository(IntegrationEntity)
      .update(
        { name: In([...INTEGRATION_NAMES]) },
        { baseUrl: null, version: null, authRef: null, enabled: false },
      );
  });

  afterAll(async () => {
    if (ds) {
      const repo = ds.getRepository(IntegrationEntity);
      for (const row of saved) {
        await repo.update(
          { name: row.name },
          {
            baseUrl: row.baseUrl,
            version: row.version,
            authRef: row.authRef,
            enabled: row.enabled,
            updatedById: row.updatedById,
          },
        );
      }
      if (users.length) await ds.getRepository(UserEntity).delete(users);
    }
    await moduleRef?.close();
  });

  it('lists both integrations, disabled by default', async () => {
    const { items } = await svc.list();
    expect(items.map((i) => i.name)).toEqual(['shoedna', 'valuelens']);
    for (const i of items) expect(i.enabled).toBe(false);
  });

  it('applies a partial update and records the admin', async () => {
    const admin = await newAdmin();
    const v = await svc.update(
      'shoedna',
      { baseUrl: 'https://shoedna.example.com', version: '2.3.0' },
      admin,
    );
    expect(v).toMatchObject({
      baseUrl: 'https://shoedna.example.com',
      version: '2.3.0',
      enabled: false,
      updatedBy: { id: admin },
    });

    const bumped = await svc.update('shoedna', { version: '2.4.0' }, admin);
    expect(bumped.baseUrl).toBe('https://shoedna.example.com');
    expect(bumped.version).toBe('2.4.0');
  });

  it('refuses to enable without a baseUrl (409 INTEGRATION_INCOMPLETE)', async () => {
    const admin = await newAdmin();
    expect(await code(svc.update('valuelens', { enabled: true }, admin))).toBe(
      'INTEGRATION_INCOMPLETE',
    );
  });

  it('answers an unknown name with INTEGRATION_NOT_FOUND', async () => {
    const admin = await newAdmin();
    expect(await code(svc.update('nope', {}, admin))).toBe(
      'INTEGRATION_NOT_FOUND',
    );
  });

  it('getActive returns settings only while enabled', async () => {
    const admin = await newAdmin();
    await svc.update(
      'valuelens',
      { baseUrl: 'https://valuelens.example.com', enabled: true },
      admin,
    );
    expect(await svc.getActive('valuelens')).toMatchObject({
      baseUrl: 'https://valuelens.example.com',
    });
    await svc.update('valuelens', { enabled: false }, admin);
    expect(await svc.getActive('valuelens')).toBeNull();
  });

  it('a no-op update keeps the previous updatedBy', async () => {
    const first = await newAdmin();
    const second = await newAdmin();
    await svc.update('shoedna', { version: '9' }, first);
    const v = await svc.update('shoedna', { version: '9' }, second);
    expect(v.updatedBy?.id).toBe(first);
  });

  it('serialises concurrent partial updates without losing either field', async () => {
    const admin = await newAdmin();
    await Promise.all([
      svc.update('shoedna', { version: '5' }, admin),
      svc.update('shoedna', { authRef: 'earthdna/be/shoedna-key' }, admin),
    ]);
    const { items } = await svc.list();
    expect(items.find((i) => i.name === 'shoedna')).toMatchObject({
      version: '5',
      authRef: 'earthdna/be/shoedna-key',
    });
  });

  it('keeps the setting when the admin account is deleted (SET NULL)', async () => {
    const admin = await newAdmin();
    await svc.update('shoedna', { version: '7' }, admin);
    await ds.getRepository(UserEntity).delete(admin);
    const { items } = await svc.list();
    expect(items.find((i) => i.name === 'shoedna')).toMatchObject({
      version: '7',
      updatedBy: null,
    });
  });

  it('the CHECK constraint backs the service rule', async () => {
    await expect(
      ds
        .getRepository(IntegrationEntity)
        .update({ name: 'shoedna' }, { enabled: true, baseUrl: null }),
    ).rejects.toThrow(/CHK_integrations_enabled_url/);
  });
});
