import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../../common/errors/api-error';
import type { UserService } from '../../user/user.service';
import type { UserRole } from '../../user/user-roles';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let users: { findById: jest.Mock };
  let guard: RolesGuard;

  const ctx = (user?: { sub?: string; role?: UserRole }) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const forbidden = async (p: Promise<boolean>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(403);
    expect((err as ApiError).code).toBe('FORBIDDEN_ROLE');
  };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    users = { findById: jest.fn() };
    guard = new RolesGuard(
      reflector as unknown as Reflector,
      users as unknown as UserService,
    );
  });

  it('lets a route without @Roles through without a DB read', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(ctx({ sub: 'u1' }))).resolves.toBe(true);
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('admits a user whose stored role matches', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    users.findById.mockResolvedValue({ id: 'u1', role: 'ADMIN' });
    await expect(guard.canActivate(ctx({ sub: 'u1' }))).resolves.toBe(true);
  });

  it('rejects a USER with 403 FORBIDDEN_ROLE', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    users.findById.mockResolvedValue({ id: 'u1', role: 'USER' });
    await forbidden(guard.canActivate(ctx({ sub: 'u1' })));
  });

  it('trusts the DB, not the JWT claim (a demoted admin is out at once)', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    users.findById.mockResolvedValue({ id: 'u1', role: 'USER' });
    await forbidden(guard.canActivate(ctx({ sub: 'u1', role: 'ADMIN' })));
  });

  it('answers a deleted account with 403, not 404', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    users.findById.mockRejectedValue(new NotFoundException());
    await forbidden(guard.canActivate(ctx({ sub: 'gone' })));
  });

  it('rejects a request with no authenticated user', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    await forbidden(guard.canActivate(ctx(undefined)));
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('lets a DB failure surface as a 500 rather than a 403', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    users.findById.mockRejectedValue(new Error('connection lost'));
    await expect(guard.canActivate(ctx({ sub: 'u1' }))).rejects.toThrow(
      'connection lost',
    );
  });
});
