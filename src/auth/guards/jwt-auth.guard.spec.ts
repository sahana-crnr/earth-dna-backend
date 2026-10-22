// JwtAuthGuard: a password reset must end every access token issued before it,
// while the login that follows the reset keeps working.
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UserService } from '../../user/user.service';

describe('JwtAuthGuard', () => {
  const RESET_AT = new Date('2026-10-21T10:00:00.500Z');
  const RESET_SECONDS = Math.floor(RESET_AT.getTime() / 1000);

  let payload: { sub: string; email: string; iat: number };
  let changedAt: Date | null;
  let guard: JwtAuthGuard;

  const ctx = (authorization?: string) => {
    const request: Record<string, unknown> = { headers: { authorization } };
    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  };

  beforeEach(() => {
    payload = { sub: 'u1', email: 'a@b.c', iat: RESET_SECONDS - 60 };
    changedAt = null;
    const jwt = {
      verifyAsync: jest.fn(() => Promise.resolve(payload)),
    } as unknown as JwtService;
    const users = {
      getPasswordChangedAt: jest.fn(() => Promise.resolve(changedAt)),
    } as unknown as UserService;
    guard = new JwtAuthGuard(jwt, users);
  });

  it('accepts a valid token when the password was never reset', async () => {
    const { request, context } = ctx('Bearer t');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBe(payload);
  });

  it('rejects a token issued before the last password reset', async () => {
    changedAt = RESET_AT;
    await expect(guard.canActivate(ctx('Bearer t').context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the token from the login right after the reset (same second)', async () => {
    changedAt = RESET_AT;
    payload.iat = RESET_SECONDS;
    await expect(guard.canActivate(ctx('Bearer t').context)).resolves.toBe(
      true,
    );
  });

  it('rejects a missing bearer token without a lookup', async () => {
    await expect(guard.canActivate(ctx().context)).rejects.toThrow(
      'Missing access token',
    );
  });
});
