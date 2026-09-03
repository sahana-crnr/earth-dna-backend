import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { GoogleTokenVerifier } from './google-token-verifier';

// Stand-in for a payload Google would return. Only the claims we read matter.
function payload(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: 'client-a',
    sub: '1234567890',
    email: 'jane@example.com',
    email_verified: true,
    name: 'Jane Doe',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe('GoogleTokenVerifier (example-based)', () => {
  let verifier: GoogleTokenVerifier;
  let clientIds: string[];
  let verifyIdToken: jest.SpyInstance;

  beforeEach(async () => {
    clientIds = ['client-a', 'client-b'];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleTokenVerifier,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'google.clientIds' ? clientIds : undefined,
          },
        },
      ],
    }).compile();

    module.useLogger(false);
    verifier = module.get(GoogleTokenVerifier);

    verifyIdToken = jest
      .spyOn(OAuth2Client.prototype, 'verifyIdToken')
      .mockResolvedValue({ getPayload: () => payload() } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('6.1/6.2 returns the identity for a valid token', async () => {
    await expect(verifier.verify('good-token')).resolves.toEqual({
      email: 'jane@example.com',
      fullName: 'Jane Doe',
      emailVerified: true,
    });
  });

  it('passes our configured client IDs as the audience', async () => {
    await verifier.verify('good-token');
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'good-token',
      audience: clientIds,
    });
  });

  it('6.3 rejects an expired token', async () => {
    verifyIdToken.mockRejectedValue(new Error('Token used too late'));
    await expect(verifier.verify('expired')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('6.4 rejects a wrong audience', async () => {
    // The library itself enforces `aud`; this is how that surfaces to us.
    verifyIdToken.mockRejectedValue(
      new Error('Wrong recipient, payload audience != requiredAudience'),
    );
    await expect(verifier.verify('wrong-aud')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('6.5 rejects a malformed token / bad signature', async () => {
    verifyIdToken.mockRejectedValue(new Error('Invalid token signature'));
    await expect(verifier.verify('garbage')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('does not reveal WHY a token failed', async () => {
    verifyIdToken.mockRejectedValue(new Error('Token used too late'));
    await expect(verifier.verify('expired')).rejects.toThrow(
      'Invalid Google token',
    );
  });

  it('rejects a non-Google issuer', async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => payload({ iss: 'https://evil.example.com' }),
    });
    await expect(verifier.verify('bad-iss')).rejects.toThrow(
      'Invalid Google token',
    );
  });

  it('6.6 rejects an unverified email, with its own distinct message', async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => payload({ email_verified: false }),
    });
    await expect(verifier.verify('unverified')).rejects.toThrow(
      'Google account email is not verified',
    );
  });

  it('6.7 rejects a payload with no email', async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => payload({ email: undefined }),
    });
    await expect(verifier.verify('no-email')).rejects.toThrow(
      'Invalid Google token',
    );
  });

  it('rejects a token that carries no payload at all', async () => {
    verifyIdToken.mockResolvedValue({ getPayload: () => undefined });
    await expect(verifier.verify('empty')).rejects.toThrow(
      'Invalid Google token',
    );
  });

  it('6.8 FAILS CLOSED when no client IDs are configured', async () => {
    clientIds = [];
    await expect(verifier.verify('any-token')).rejects.toThrow(
      'Google sign-in is not available',
    );
    // Critical: it must never reach the library with an empty audience list.
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('falls back to the email local-part when Google sends no name', async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => payload({ name: undefined }),
    });
    await expect(verifier.verify('no-name')).resolves.toMatchObject({
      fullName: 'jane',
    });
  });

  it('falls back when the name is only whitespace', async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => payload({ name: '   ' }),
    });
    await expect(verifier.verify('blank-name')).resolves.toMatchObject({
      fullName: 'jane',
    });
  });

  it('6.10 NEVER logs the idToken (NFR-03)', async () => {
    const secret = 'super-secret-id-token-value';
    const logged: string[] = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((m) => void logged.push(String(m)));
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((m) => void logged.push(String(m)));

    verifyIdToken.mockRejectedValue(new Error('Invalid token signature'));
    await expect(verifier.verify(secret)).rejects.toThrow();

    clientIds = [];
    await expect(verifier.verify(secret)).rejects.toThrow();

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(secret);
    }
  });
});
