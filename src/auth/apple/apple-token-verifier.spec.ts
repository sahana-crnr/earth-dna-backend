import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import {
  AppleTokenVerifier,
  APPLE_ISSUER,
  APPLE_JWKS_URL,
} from './apple-token-verifier';
import { JwksJwtVerifier } from '../social/jwks-jwt-verifier';

// Stand-in for a verified Apple identity token payload. Only what we read matters.
function payload(overrides: Record<string, unknown> = {}) {
  return {
    iss: APPLE_ISSUER,
    aud: 'com.example.earthDnaApp',
    sub: '001234.abcdef.5678',
    email: 'jane@privaterelay.appleid.com',
    email_verified: 'true',
    is_private_email: 'true',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe('AppleTokenVerifier (example-based)', () => {
  let verifier: AppleTokenVerifier;
  let clientIds: string[];
  let jwks: jest.Mocked<Pick<JwksJwtVerifier, 'verify'>>;

  beforeEach(async () => {
    clientIds = ['com.example.earthDnaApp', 'com.earthdna.app'];
    jwks = { verify: jest.fn().mockResolvedValue(payload()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppleTokenVerifier,
        { provide: JwksJwtVerifier, useValue: jwks },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'apple.clientIds' ? clientIds : undefined,
          },
        },
      ],
    }).compile();
    module.useLogger(false);
    verifier = module.get(AppleTokenVerifier);
  });

  it('returns the identity for a valid token, keyed on sub', async () => {
    await expect(verifier.verify('good', 'Kiran Jadhav')).resolves.toEqual({
      provider: 'apple',
      providerUserId: '001234.abcdef.5678',
      email: 'jane@privaterelay.appleid.com',
      fullName: 'Kiran Jadhav',
    });
  });

  it('verifies against Apple JWKS, issuer and OUR bundle IDs', async () => {
    await verifier.verify('good');
    expect(jwks.verify).toHaveBeenCalledWith('good', {
      jwksUrl: APPLE_JWKS_URL,
      issuer: APPLE_ISSUER,
      audience: clientIds,
    });
  });

  it('falls back to the email local-part when no name hint is given (repeat sign-in)', async () => {
    const id = await verifier.verify('good');
    expect(id.fullName).toBe('jane');
  });

  it('treats a whitespace-only name hint as absent', async () => {
    const id = await verifier.verify('good', '   ');
    expect(id.fullName).toBe('jane');
  });

  it('lower-cases and trims the email', async () => {
    jwks.verify.mockResolvedValue(payload({ email: '  Jane@Example.COM ' }));
    const id = await verifier.verify('good');
    expect(id.email).toBe('jane@example.com');
  });

  it('keeps a private relay address as-is (it is real and deliverable)', async () => {
    const id = await verifier.verify('good');
    expect(id.email).toBe('jane@privaterelay.appleid.com');
  });

  it.each([
    ['expired', 'JWTExpired: "exp" claim timestamp check failed'],
    ['wrong audience', 'unexpected "aud" claim value'],
    ['wrong issuer', 'unexpected "iss" claim value'],
    ['bad signature', 'signature verification failed'],
    ['unknown key', 'no applicable key found in the JSON Web Key Set'],
  ])('rejects %s with the generic message', async (_label, libMessage) => {
    jwks.verify.mockRejectedValue(new Error(libMessage));
    await expect(verifier.verify('bad')).rejects.toThrow('Invalid Apple token');
  });

  it('rejects a payload with no sub', async () => {
    jwks.verify.mockResolvedValue(payload({ sub: undefined }));
    await expect(verifier.verify('nosub')).rejects.toThrow(
      'Invalid Apple token',
    );
  });

  it('rejects an explicitly unverified email with its own message', async () => {
    jwks.verify.mockResolvedValue(payload({ email_verified: 'false' }));
    await expect(verifier.verify('unverified')).rejects.toThrow(
      'Apple account email is not verified',
    );
    jwks.verify.mockResolvedValue(payload({ email_verified: false }));
    await expect(verifier.verify('unverified')).rejects.toThrow(
      'Apple account email is not verified',
    );
  });

  it('accepts a token with no email_verified claim at all', async () => {
    jwks.verify.mockResolvedValue(payload({ email_verified: undefined }));
    await expect(verifier.verify('good')).resolves.toMatchObject({
      email: 'jane@privaterelay.appleid.com',
    });
  });

  it('returns a null email when the claim is absent, not a fabricated one', async () => {
    jwks.verify.mockResolvedValue(payload({ email: undefined }));
    const id = await verifier.verify('good', 'Kiran');
    expect(id.email).toBeNull();
    expect(id.fullName).toBe('Kiran');
  });

  it('fails closed when APPLE_CLIENT_IDS is empty and never calls the verifier', async () => {
    clientIds.length = 0;
    await expect(verifier.verify('good')).rejects.toThrow(
      'Apple sign-in is not available',
    );
    expect(jwks.verify).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException (401), never a 500', async () => {
    jwks.verify.mockRejectedValue(new Error('anything'));
    await expect(verifier.verify('bad')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
