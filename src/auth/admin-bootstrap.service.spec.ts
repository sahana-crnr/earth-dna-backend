import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import type { AdminConfig } from '../config/admin.config';
import type { RefreshTokenService } from './refresh-token.service';
import type { UserEntity } from '../user/entities/user.entity';
import { AdminBootstrapService } from './admin-bootstrap.service';

const GOOD = 'a-long-admin-password';

type Row = Partial<UserEntity>;
type Where = string | { role?: string; id?: unknown };

describe('AdminBootstrapService', () => {
  let repo: {
    findOne: jest.Mock<Promise<Row | null>, [unknown]>;
    create: jest.Mock<Row, [Row]>;
    save: jest.Mock<Promise<Row>, [Row]>;
    update: jest.Mock<Promise<{ affected: number }>, [Where, Row]>;
  };
  let query: jest.Mock;
  let revokeAllForUser: jest.Mock;
  let adminCfg: AdminConfig;
  let svc: AdminBootstrapService;

  /** Rows the "demote everyone except X" update touched, per call. */
  const demoteCalls = () =>
    repo.update.mock.calls.filter(
      ([where]) => typeof where === 'object' && where.role === 'ADMIN',
    );
  const hashOf = (r: Row | undefined) => r?.password ?? '';

  beforeAll(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    repo = {
      findOne: jest
        .fn<Promise<Row | null>, [unknown]>()
        .mockResolvedValue(null),
      create: jest.fn((v: Row) => v),
      save: jest.fn((v: Row) => Promise.resolve({ id: 'new-id', ...v })),
      update: jest
        .fn<Promise<{ affected: number }>, [Where, Row]>()
        .mockResolvedValue({ affected: 0 }),
    };
    query = jest.fn().mockResolvedValue(undefined);
    revokeAllForUser = jest.fn().mockResolvedValue(undefined);
    adminCfg = {
      email: 'admin@earthdna.test',
      password: GOOD,
      disabled: false,
    };

    const m = { query, getRepository: () => repo };
    const ds = {
      transaction: (cb: (em: typeof m) => Promise<unknown>) => cb(m),
    } as unknown as DataSource;
    const config = {
      get: (k: string) => (k === 'admin' ? adminCfg : undefined),
    } as unknown as ConfigService;
    svc = new AdminBootstrapService(ds, config, {
      revokeAllForUser,
    } as unknown as RefreshTokenService);
  });

  it('takes the advisory lock before touching users', async () => {
    await svc.sync();
    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1)', [
      expect.any(Number),
    ]);
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(
      repo.findOne.mock.invocationCallOrder[0],
    );
  });

  it('creates a local ADMIN with a bcrypt hash when the account is missing', async () => {
    await expect(svc.sync()).resolves.toBe('created');
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      email: adminCfg.email,
      authProvider: 'local',
      role: 'ADMIN',
    });
    expect(hashOf(saved)).not.toBe(GOOD);
    expect(await bcrypt.compare(GOOD, hashOf(saved))).toBe(true);
  });

  // The row may have been registered by someone else before ADMIN_EMAIL was
  // set: their refresh token must not survive into an admin session.
  it('promotes an existing local USER and signs it out everywhere', async () => {
    repo.findOne.mockResolvedValue({
      id: 'u1',
      role: 'USER',
      authProvider: 'local',
      password: await bcrypt.hash(GOOD, 4),
    });
    await expect(svc.sync()).resolves.toBe('promoted');
    expect(repo.update).toHaveBeenCalledWith('u1', { role: 'ADMIN' });
    expect(revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('promotes and rehashes in one boot, still signing the account out', async () => {
    repo.findOne.mockResolvedValue({
      id: 'u1',
      role: 'USER',
      authProvider: 'local',
      password: await bcrypt.hash('a-stranger-password', 4),
    });
    await expect(svc.sync()).resolves.toBe('promoted');
    expect(revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('does not revoke anything when the admin is created fresh', async () => {
    await expect(svc.sync()).resolves.toBe('created');
    expect(revokeAllForUser).not.toHaveBeenCalled();
  });

  it('writes nothing for the admin row when role and password already match', async () => {
    repo.findOne.mockResolvedValue({
      id: 'u1',
      role: 'ADMIN',
      authProvider: 'local',
      password: await bcrypt.hash(GOOD, 4),
    });
    await expect(svc.sync()).resolves.toBe('unchanged');
    expect(repo.update).not.toHaveBeenCalledWith('u1', expect.anything());
    expect(repo.save).not.toHaveBeenCalled();
    expect(revokeAllForUser).not.toHaveBeenCalled();
  });

  it('rehashes a rotated ADMIN_PASSWORD and revokes the admin sessions', async () => {
    repo.findOne.mockResolvedValue({
      id: 'u1',
      role: 'ADMIN',
      authProvider: 'local',
      password: await bcrypt.hash('the-old-admin-password', 4),
    });
    await expect(svc.sync()).resolves.toBe('updated');
    const call = repo.update.mock.calls.find(([id]) => id === 'u1');
    expect(await bcrypt.compare(GOOD, hashOf(call?.[1]))).toBe(true);
    expect(revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('demotes every other admin, keeping only the ADMIN_EMAIL account', async () => {
    repo.findOne.mockResolvedValue({
      id: 'u1',
      role: 'ADMIN',
      authProvider: 'local',
      password: await bcrypt.hash(GOOD, 4),
    });
    await svc.sync();
    const [[where, set]] = demoteCalls();
    expect(typeof where === 'object' && where.id).toBeDefined(); // Not('u1')
    expect(set).toEqual({ role: 'USER' });
  });

  it('refuses to promote a social account and leaves no admin', async () => {
    repo.findOne.mockResolvedValue({
      id: 'g1',
      role: 'USER',
      authProvider: 'google',
      password: null,
    });
    await expect(svc.sync()).resolves.toBe('refused');
    expect(repo.update).not.toHaveBeenCalledWith('g1', expect.anything());
    expect(demoteCalls()[0]).toEqual([{ role: 'ADMIN' }, { role: 'USER' }]);
  });

  // A broken secret during a deploy must not lock everyone out.
  it.each([
    ['email unset', { email: null, password: GOOD }],
    ['password unset', { email: 'admin@earthdna.test', password: null }],
    ['password too short', { email: 'admin@earthdna.test', password: 'short' }],
  ])('leaves the current admin alone when %s', async (_, c) => {
    adminCfg = { ...c, disabled: false };
    await expect(svc.sync()).resolves.toBe('skipped');
    expect(query).not.toHaveBeenCalled();
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it.each([
    ['valid credentials', { email: 'admin@earthdna.test', password: GOOD }],
    ['no credentials', { email: null, password: null }],
  ])(
    'ADMIN_DISABLE=true demotes every admin and creates none (%s)',
    async (_, c) => {
      adminCfg = { ...c, disabled: true };
      await expect(svc.sync()).resolves.toBe('disabled');
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
      expect(demoteCalls()[0]).toEqual([{ role: 'ADMIN' }, { role: 'USER' }]);
    },
  );

  it('logs rather than throws at boot, so a failure never stops the app', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
