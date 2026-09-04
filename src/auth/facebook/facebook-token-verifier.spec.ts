import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  FacebookTokenVerifier,
  FACEBOOK_ISSUER,
  FACEBOOK_JWKS_URL,
} from './facebook-token-verifier';
import { JwksJwtVerifier } from '../social/jwks-jwt-verifier';

const APP_ID = '1090683699976735';
const APP_SECRET = 'test-app-secret';

/** A string with the three-segment shape of a JWT (content is irrelevant - jwks is mocked). */
const JWT_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
/** A classic opaque token, as Android sends. */
const OPAQUE = 'EAAPfZBZAZCZBZAZCBAOZBxyz123';

function jwtPayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: FACEBOOK_ISSUER,
    aud: APP_ID,
    sub: '10223456789012345',
    email: 'jane@example.com',
    name: 'Jane Doe',
    given_name: 'Jane',
    family_name: 'Doe',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

/** Sequenced fetch mock: first call = debug_token, second = /me. */
function mockGraph(
  debug: unknown,
  me: unknown,
  opts: { debugStatus?: number; meStatus?: number } = {},
) {
  const fetchMock = jest.fn();
  fetchMock
    .mockResolvedValueOnce({
      ok: (opts.debugStatus ?? 200) < 400,
      status: opts.debugStatus ?? 200,
      json: () => Promise.resolve(debug),
    })
    .mockResolvedValueOnce({
      ok: (opts.meStatus ?? 200) < 400,
      status: opts.meStatus ?? 200,
      json: () => Promise.resolve(me),
    });
  global.fetch = fetchMock;
  return fetchMock;
}

const validDebug = (over: Record<string, unknown> = {}) => ({
  data: {
    app_id: APP_ID,
    is_valid: true,
    user_id: '10223456789012345',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  },
});
const validMe = (over: Record<string, unknown> = {}) => ({
  id: '10223456789012345',
  name: 'Jane Doe',
  email: 'jane@example.com',
  ...over,
});

describe('FacebookTokenVerifier (example-based)', () => {
  let verifier: FacebookTokenVerifier;
  let jwks: jest.Mocked<Pick<JwksJwtVerifier, 'verify'>>;
  let config: { appId: string; appSecret: string };
  const realFetch = global.fetch;

  beforeEach(async () => {
    config = { appId: APP_ID, appSecret: APP_SECRET };
    jwks = { verify: jest.fn().mockResolvedValue(jwtPayload()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FacebookTokenVerifier,
        { provide: JwksJwtVerifier, useValue: jwks },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'facebook.appId'
                ? config.appId
                : key === 'facebook.appSecret'
                  ? config.appSecret
                  : undefined,
          },
        },
      ],
    }).compile();
    module.useLogger(false);
    verifier = module.get(FacebookTokenVerifier);
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  // ── Path selection ────────────────────────────────────────────────────────
  describe('path selection', () => {
    it('routes a three-segment token to the JWT path and never calls Graph', async () => {
      const fetchMock = mockGraph({}, {});
      await verifier.verify(JWT_SHAPED);
      expect(jwks.verify).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('routes an opaque token to the Graph path and never calls jwks', async () => {
      mockGraph(validDebug(), validMe());
      await verifier.verify(OPAQUE);
      expect(jwks.verify).not.toHaveBeenCalled();
    });

    it('fails closed on BOTH paths when FACEBOOK_APP_ID is empty', async () => {
      config.appId = '';
      const fetchMock = mockGraph(validDebug(), validMe());
      await expect(verifier.verify(JWT_SHAPED)).rejects.toThrow(
        'Facebook sign-in is not available',
      );
      await expect(verifier.verify(OPAQUE)).rejects.toThrow(
        'Facebook sign-in is not available',
      );
      expect(jwks.verify).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ── iOS: Limited Login JWT ────────────────────────────────────────────────
  describe('Limited Login JWT (iOS)', () => {
    it('returns the identity keyed on sub', async () => {
      await expect(verifier.verify(JWT_SHAPED)).resolves.toEqual({
        provider: 'facebook',
        providerUserId: '10223456789012345',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
      });
    });

    it('verifies against Facebook JWKS, issuer and OUR app id', async () => {
      await verifier.verify(JWT_SHAPED);
      expect(jwks.verify).toHaveBeenCalledWith(JWT_SHAPED, {
        jwksUrl: FACEBOOK_JWKS_URL,
        issuer: FACEBOOK_ISSUER,
        audience: APP_ID,
      });
    });

    it.each([
      ['expired', '"exp" claim timestamp check failed'],
      ['wrong audience', 'unexpected "aud" claim value'],
      ['wrong issuer', 'unexpected "iss" claim value'],
      ['bad signature', 'signature verification failed'],
    ])('rejects %s with the generic message', async (_l, msg) => {
      jwks.verify.mockRejectedValue(new Error(msg));
      await expect(verifier.verify(JWT_SHAPED)).rejects.toThrow(
        'Invalid Facebook token',
      );
    });

    it('rejects a payload with no sub', async () => {
      jwks.verify.mockResolvedValue(jwtPayload({ sub: '' }));
      await expect(verifier.verify(JWT_SHAPED)).rejects.toThrow(
        'Invalid Facebook token',
      );
    });

    it('returns null email when the user withheld it (no fabrication)', async () => {
      jwks.verify.mockResolvedValue(jwtPayload({ email: undefined }));
      const id = await verifier.verify(JWT_SHAPED);
      expect(id.email).toBeNull();
      expect(id.fullName).toBe('Jane Doe');
    });

    it('builds the name from given_name + family_name when name is absent', async () => {
      jwks.verify.mockResolvedValue(jwtPayload({ name: undefined }));
      const id = await verifier.verify(JWT_SHAPED);
      expect(id.fullName).toBe('Jane Doe');
    });

    it('works with the JWT path even when FACEBOOK_APP_SECRET is empty', async () => {
      config.appSecret = '';
      await expect(verifier.verify(JWT_SHAPED)).resolves.toMatchObject({
        providerUserId: '10223456789012345',
      });
    });
  });

  // ── Android: classic opaque token ─────────────────────────────────────────
  describe('classic access token (Android)', () => {
    it('returns the identity from /me after a valid debug_token', async () => {
      mockGraph(validDebug(), validMe());
      await expect(verifier.verify(OPAQUE)).resolves.toEqual({
        provider: 'facebook',
        providerUserId: '10223456789012345',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
      });
    });

    it('calls debug_token with the APP access token, then /me with appsecret_proof', async () => {
      const fetchMock = mockGraph(validDebug(), validMe());
      await verifier.verify(OPAQUE);

      const [debugUrl] = fetchMock.mock.calls[0] as [URL];
      expect(debugUrl.pathname).toBe('/debug_token');
      expect(debugUrl.searchParams.get('input_token')).toBe(OPAQUE);
      expect(debugUrl.searchParams.get('access_token')).toBe(
        `${APP_ID}|${APP_SECRET}`,
      );

      const [meUrl] = fetchMock.mock.calls[1] as [URL];
      expect(meUrl.pathname).toMatch(/^\/v\d+\.\d+\/me$/);
      expect(meUrl.searchParams.get('fields')).toBe('id,name,email');
      expect(meUrl.searchParams.get('access_token')).toBe(OPAQUE);
      const expectedProof = crypto
        .createHmac('sha256', APP_SECRET)
        .update(OPAQUE)
        .digest('hex');
      expect(meUrl.searchParams.get('appsecret_proof')).toBe(expectedProof);
    });

    it('rejects when debug_token says is_valid=false', async () => {
      const fetchMock = mockGraph(
        validDebug({ is_valid: false, error: { message: 'Session expired' } }),
        validMe(),
      );
      await expect(verifier.verify(OPAQUE)).rejects.toThrow(
        'Invalid Facebook token',
      );
      // Never proceeds to /me with a token we already know is bad.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a token minted for a DIFFERENT app', async () => {
      mockGraph(validDebug({ app_id: '999' }), validMe());
      await expect(verifier.verify(OPAQUE)).rejects.toThrow(
        'Invalid Facebook token',
      );
    });

    it('rejects an expired token per expires_at', async () => {
      mockGraph(
        validDebug({ expires_at: Math.floor(Date.now() / 1000) - 10 }),
        validMe(),
      );
      await expect(verifier.verify(OPAQUE)).rejects.toThrow(
        'Invalid Facebook token',
      );
    });

    it('accepts expires_at = 0 (never expires)', async () => {
      mockGraph(validDebug({ expires_at: 0 }), validMe());
      await expect(verifier.verify(OPAQUE)).resolves.toBeDefined();
    });

    it('rejects a Graph error body (bad token -> 400 with error JSON)', async () => {
      mockGraph(
        { error: { message: 'Invalid OAuth access token.' } },
        validMe(),
        { debugStatus: 400 },
      );
      await expect(verifier.verify(OPAQUE)).rejects.toThrow(
        'Invalid Facebook token',
      );
    });

    it('rejects when /me returns an error', async () => {
      mockGraph(validDebug(), { error: { message: 'nope' } });
      await expect(verifier.verify(OPAQUE)).rejects.toThrow(
        'Invalid Facebook token',
      );
    });

    it('rejects when /me id does not match debug_token user_id', async () => {
      mockGraph(validDebug({ user_id: '1' }), validMe({ id: '2' }));
      await expect(verifier.verify(OPAQUE)).rejects.toThrow(
        'Invalid Facebook token',
      );
    });

    it('turns a network failure / timeout into 401, never 500', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(
          new Error('The operation was aborted due to timeout'),
        );
      await expect(verifier.verify(OPAQUE)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('returns null email when Facebook omits it', async () => {
      mockGraph(validDebug(), validMe({ email: undefined }));
      const id = await verifier.verify(OPAQUE);
      expect(id.email).toBeNull();
    });

    it('fails closed on the opaque path when FACEBOOK_APP_SECRET is empty', async () => {
      config.appSecret = '';
      const fetchMock = mockGraph(validDebug(), validMe());
      await expect(verifier.verify(OPAQUE)).rejects.toThrow(
        'Facebook sign-in is not available',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
