// Integration tests for the forgot/reset password fix (PR 17) against a real
// PostgreSQL (local-infra, port 5433), migrated. Covers what mocks cannot: the
// LOWER() lookups and their unique index, the single-use conditional UPDATE,
// and refresh-token behaviour after a reset.
//
// Skipped unless SCAN_IT_DB=1, so `npm test` needs no database:
//   npm run db:start && npm run migration:run && npm run test:scan-it
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import * as crypto from 'crypto';
import { randomUUID } from 'node:crypto';
import { UserEntity } from '../user/entities/user.entity';
import { UserService } from '../user/user.service';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { RefreshTokenService } from './refresh-token.service';

loadEnv();
const RUN = process.env.SCAN_IT_DB === '1';
const d = RUN ? describe : describe.skip;

const sha256 = (s: string) =>
  crypto.createHash('sha256').update(s).digest('hex');

d('Password reset (integration, real Postgres)', () => {
  let moduleRef: TestingModule;
  let ds: DataSource;
  let users: UserService;
  let tokens: RefreshTokenService;
  const created: string[] = [];

  async function newUser(email = `reset-it-${randomUUID()}@local.test`) {
    const user = await users.create({
      fullName: 'Reset IT',
      email,
      password: 'old-hash',
      country: 'USA',
    });
    created.push(user.id);
    return user;
  }

  async function giveResetToken(userId: string): Promise<string> {
    const raw = crypto.randomBytes(32).toString('hex');
    await users.setResetToken(
      userId,
      sha256(raw),
      new Date(Date.now() + 60_000),
    );
    return sha256(raw);
  }

  // What AuthService.resetPassword does, minus bcrypt.
  const reset = (hashedToken: string, hashedPassword = 'new-hash') =>
    ds.transaction(async (m) => {
      const id = await users.consumeResetToken(m, hashedToken, hashedPassword);
      if (id) await tokens.revokeAllForUser(id, m);
      return id;
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
        TypeOrmModule.forFeature([UserEntity, RefreshTokenEntity]),
      ],
      providers: [
        UserService,
        RefreshTokenService,
        { provide: ConfigService, useValue: { get: () => '30d' } },
      ],
    }).compile();
    ds = moduleRef.get(DataSource);
    users = moduleRef.get(UserService);
    tokens = moduleRef.get(RefreshTokenService);
  });

  afterAll(async () => {
    if (ds && created.length) {
      await ds
        .getRepository(RefreshTokenEntity)
        .delete({ userId: In(created) });
      await ds.getRepository(UserEntity).delete({ id: In(created) });
    }
    await moduleRef?.close();
  });

  describe('email normalisation', () => {
    it('stores a new email trimmed and lowercased', async () => {
      const id = randomUUID();
      const user = await newUser(`  Mixed.${id}@Example.COM `);
      expect(user.email).toBe(`mixed.${id}@example.com`);
    });

    it('finds the account whatever the letter case, with and without password', async () => {
      const user = await newUser();
      const shouted = user.email.toUpperCase();
      expect((await users.findByEmail(shouted))?.id).toBe(user.id);
      expect((await users.findByEmailWithPassword(shouted))?.password).toBe(
        'old-hash',
      );
    });

    it('treats "_" literally (LOWER(), not ILIKE)', async () => {
      const id = randomUUID().slice(0, 8);
      await newUser(`a_b.${id}@local.test`);
      expect(await users.findByEmail(`axb.${id}@local.test`)).toBeNull();
    });

    it('rejects a second account that differs only by case', async () => {
      const user = await newUser();
      await expect(
        ds
          .getRepository(UserEntity)
          .insert({ fullName: 'Dup', email: user.email.toUpperCase() }),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('consumeResetToken', () => {
    it('sets the password, clears the token and stamps passwordChangedAt', async () => {
      const user = await newUser();
      const hashed = await giveResetToken(user.id);

      await expect(reset(hashed)).resolves.toBe(user.id);

      const row = await ds.getRepository(UserEntity).findOne({
        where: { id: user.id },
        select: { id: true, password: true, resetPasswordToken: true },
      });
      expect(row).toMatchObject({
        password: 'new-hash',
        resetPasswordToken: null,
      });
      expect(await users.getPasswordChangedAt(user.id)).toBeInstanceOf(Date);
    });

    it('lets exactly one of two concurrent resets use the token', async () => {
      const user = await newUser();
      const hashed = await giveResetToken(user.id);

      const results = await Promise.all([
        reset(hashed, 'first'),
        reset(hashed, 'second'),
      ]);

      expect(results.filter((r) => r === user.id)).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(1);
    });

    it('refuses an expired token', async () => {
      const user = await newUser();
      const hashed = sha256('expired');
      await users.setResetToken(user.id, hashed, new Date(Date.now() - 1000));
      await expect(reset(hashed)).resolves.toBeNull();
    });
  });

  describe('refresh tokens around a reset', () => {
    it('an old device refreshing after a reset gets 401 but does NOT end the new session', async () => {
      const user = await newUser();
      const oldDevice = await tokens.issue(user.id);
      await reset(await giveResetToken(user.id));
      const newSession = await tokens.issue(user.id);

      await expect(tokens.rotate(oldDevice)).rejects.toThrow(
        UnauthorizedException,
      );
      // No false "reuse" alarm: the session started after the reset survives.
      await expect(tokens.rotate(newSession)).resolves.toMatchObject({
        userId: user.id,
      });
    });

    it('presenting an already-rotated token is still treated as theft', async () => {
      const user = await newUser();
      const first = await tokens.issue(user.id);
      const { rawToken: second } = await tokens.rotate(first);

      await expect(tokens.rotate(first)).rejects.toThrow(UnauthorizedException);
      await expect(tokens.rotate(second)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a refresh racing a reset never leaves a live token behind', async () => {
      const user = await newUser();
      const device = await tokens.issue(user.id);
      const hashed = await giveResetToken(user.id);

      await Promise.allSettled([tokens.rotate(device), reset(hashed)]);

      const live = await ds
        .getRepository(RefreshTokenEntity)
        .createQueryBuilder('t')
        .where('t.userId = :id', { id: user.id })
        .andWhere('t.revokedAt IS NULL')
        .getCount();
      expect(live).toBe(0);
    });
  });
});
