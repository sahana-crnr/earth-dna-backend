// Property-based tests for the social sign-in unit (Facebook + Apple).
//
// These COMPLEMENT the example-based specs next to each verifier - they never
// replace them (PBT-10). Shrinking is on and no seed is pinned (PBT-08).
import { DataSource } from 'typeorm';
import fc from 'fast-check';
import { instanceToPlain } from 'class-transformer';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnprocessableEntityException } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { UserService } from '../../user/user.service';
import { MailService } from '../../mail/mail.service';
import { RefreshTokenService } from '../refresh-token.service';
import { GoogleTokenVerifier } from '../google/google-token-verifier';
import { FacebookTokenVerifier } from '../facebook/facebook-token-verifier';
import { AppleTokenVerifier } from '../apple/apple-token-verifier';
import { JwksJwtVerifier, looksLikeJwt } from './jwks-jwt-verifier';
import { SocialIdentity } from './social-identity';
import { UserEntity, SocialProvider } from '../../user/entities/user.entity';
import { AuthResponse } from '../interfaces/auth-response.interface';
import {
  APPLE_CLIENT_IDS,
  FACEBOOK_APP_ID,
  validApplePayload,
  invalidAudienceApplePayload,
  validFacebookJwtPayload,
  validGraphPairArb,
  opaqueFacebookTokenArb,
  jwtShapedTokenArb,
  socialIdentityArb,
} from './__generators__/social.generators';

const PASSWORD = 'Password123';
/** Precomputed bcrypt hash of PASSWORD (cost 4 - test speed, not production). */
const PASSWORD_HASH =
  '$2b$04$CoCzkB81uRTf2Ka0GbBsceWQCJPmVx4Dmvja2AxIhHPwlWKd8P3d2';

// ── Verifier-level properties ───────────────────────────────────────────────
async function buildVerifiers(cfg: {
  appleClientIds: string[];
  facebookAppId: string;
  facebookAppSecret: string;
}) {
  const jwks = { verify: jest.fn() };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AppleTokenVerifier,
      FacebookTokenVerifier,
      { provide: JwksJwtVerifier, useValue: jwks },
      {
        provide: ConfigService,
        useValue: {
          get: (k: string) =>
            ({
              'apple.clientIds': cfg.appleClientIds,
              'facebook.appId': cfg.facebookAppId,
              'facebook.appSecret': cfg.facebookAppSecret,
            })[k],
        },
      },
    ],
  }).compile();
  module.useLogger(false);
  return {
    apple: module.get(AppleTokenVerifier),
    facebook: module.get(FacebookTokenVerifier),
    jwks,
  };
}

describe('social verifier properties', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  // ── P3 (Invariant): shape sniffing never misroutes ────────────────────────
  it('P3: every opaque token goes to Graph, every JWT-shaped token to JWKS', async () => {
    const { facebook, jwks } = await buildVerifiers({
      appleClientIds: APPLE_CLIENT_IDS,
      facebookAppId: FACEBOOK_APP_ID,
      facebookAppSecret: 's',
    });

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          opaqueFacebookTokenArb.map((t) => ({ t, jwt: false })),
          jwtShapedTokenArb.map((t) => ({ t, jwt: true })),
        ),
        validGraphPairArb,
        validFacebookJwtPayload(),
        async ({ t, jwt }, pair, payload) => {
          expect(looksLikeJwt(t)).toBe(jwt);

          jwks.verify.mockReset().mockResolvedValue(payload);
          const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({ json: () => Promise.resolve(pair.debug) })
            .mockResolvedValueOnce({ json: () => Promise.resolve(pair.me) });
          global.fetch = fetchMock;

          const id = await facebook.verify(t);
          expect(id.provider).toBe('facebook');
          if (jwt) {
            expect(jwks.verify).toHaveBeenCalledTimes(1);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(id.providerUserId).toBe(payload.sub);
          } else {
            expect(jwks.verify).not.toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(id.providerUserId).toBe(pair.me.id);
          }
          // Name fallback never yields an empty string (P6).
          expect(id.fullName.trim().length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── P5 (Invariant): wrong audience is always 401 ──────────────────────────
  it('P5: NO Apple payload whose aud is outside the configured list is accepted', async () => {
    const { apple, jwks } = await buildVerifiers({
      appleClientIds: APPLE_CLIENT_IDS,
      facebookAppId: FACEBOOK_APP_ID,
      facebookAppSecret: 's',
    });

    await fc.assert(
      fc.asyncProperty(invalidAudienceApplePayload(), async (payload) => {
        // Mirror the library: jose enforces aud itself and throws.
        jwks.verify
          .mockReset()
          .mockImplementation(
            (_t: string, o: { audience: string | string[] }) => {
              const allowed = Array.isArray(o.audience)
                ? o.audience
                : [o.audience];
              return allowed.includes(payload.aud)
                ? Promise.resolve(payload)
                : Promise.reject(new Error('unexpected "aud" claim value'));
            },
          );
        await expect(apple.verify('token')).rejects.toThrow(
          'Invalid Apple token',
        );
      }),
      { numRuns: 100 },
    );
  });

  it('P5b: an EMPTY audience list rejects every otherwise-valid payload without touching JWKS', async () => {
    const { apple, facebook, jwks } = await buildVerifiers({
      appleClientIds: [],
      facebookAppId: '',
      facebookAppSecret: '',
    });

    await fc.assert(
      fc.asyncProperty(
        validApplePayload(),
        validFacebookJwtPayload(),
        async (ap, fp) => {
          jwks.verify.mockReset().mockResolvedValue(ap);
          await expect(apple.verify('t')).rejects.toThrow(
            'Apple sign-in is not available',
          );
          jwks.verify.mockResolvedValue(fp);
          await expect(facebook.verify('a.b.c')).rejects.toThrow(
            'Facebook sign-in is not available',
          );
          expect(jwks.verify).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });

  it('accepts every valid Apple payload and keys the identity on sub', async () => {
    const { apple, jwks } = await buildVerifiers({
      appleClientIds: APPLE_CLIENT_IDS,
      facebookAppId: FACEBOOK_APP_ID,
      facebookAppSecret: 's',
    });

    await fc.assert(
      fc.asyncProperty(
        validApplePayload(),
        fc.option(fc.constantFrom('Kiran Jadhav', '  ', ''), {
          nil: undefined,
        }),
        async (payload, hint) => {
          jwks.verify.mockReset().mockResolvedValue(payload);
          const id = await apple.verify('token', hint);
          expect(id.provider).toBe('apple');
          expect(id.providerUserId).toBe(payload.sub);
          expect(id.email).toBe(payload.email);
          expect(id.fullName.trim().length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Service-level properties ────────────────────────────────────────────────
describe('socialLogin properties', () => {
  function makeUser(over: Partial<UserEntity> = {}): UserEntity {
    return {
      id: 'user-uuid',
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      password: null,
      resetPasswordToken: null,
      resetPasswordExpiry: null,
      country: null,
      countryCode: null,
      zipCode: null,
      authProvider: 'facebook',
      providerUserId: null,
      role: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
  }

  /** In-memory users table honouring BOTH unique constraints. */
  class Store {
    rows: UserEntity[] = [];
    byProvider(p: SocialProvider, id: string) {
      return (
        this.rows.find(
          (u) => u.authProvider === p && u.providerUserId === id,
        ) ?? null
      );
    }
    byEmail(e: string) {
      return this.rows.find((u) => u.email === e) ?? null;
    }
    insert(params: {
      provider: SocialProvider;
      providerUserId: string | null;
      email: string;
      fullName: string;
    }) {
      const clash =
        (params.providerUserId &&
          this.byProvider(params.provider, params.providerUserId)) ||
        this.byEmail(params.email);
      if (clash) return clash;
      const row = makeUser({
        id: `id-${this.rows.length}`,
        email: params.email,
        fullName: params.fullName,
        authProvider: params.provider,
        providerUserId: params.providerUserId,
      });
      this.rows.push(row);
      return row;
    }
  }

  async function buildService(
    store: Store,
    identities: { facebook: SocialIdentity; apple: SocialIdentity },
  ) {
    const userService = {
      findByProvider: jest.fn((p: SocialProvider, id: string) =>
        Promise.resolve(store.byProvider(p, id)),
      ),
      findByEmail: jest.fn((e: string) => Promise.resolve(store.byEmail(e))),
      findByEmailWithPassword: jest.fn((e: string) =>
        Promise.resolve(store.byEmail(e)),
      ),
      createSocialUser: jest.fn(
        (params: {
          provider: SocialProvider;
          providerUserId: string | null;
          email: string;
          fullName: string;
        }) => Promise.resolve(store.insert(params)),
      ),
      createGoogleUser: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      setResetToken: jest.fn(),
      clearResetToken: jest.fn(),
      findByResetToken: jest.fn(),
      updatePassword: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userService },
        {
          provide: MailService,
          useValue: { sendPasswordResetEmail: jest.fn() },
        },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'jwt-token') } },
        {
          provide: RefreshTokenService,
          useValue: { issue: jest.fn(() => Promise.resolve('refresh-token')) },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: GoogleTokenVerifier, useValue: { verify: jest.fn() } },
        {
          provide: FacebookTokenVerifier,
          useValue: {
            verify: jest.fn(() => Promise.resolve(identities.facebook)),
          },
        },
        {
          provide: AppleTokenVerifier,
          useValue: {
            verify: jest.fn(() => Promise.resolve(identities.apple)),
          },
        },
        // Only resetPassword uses it; these properties never reach it.
        { provide: DataSource, useValue: {} },
      ],
    }).compile();
    module.useLogger(false);
    return { service: module.get(AuthService), userService };
  }

  // ── P1 (Idempotence / determinism): same sub -> same user, ONE row ────────
  it('P1: repeated sign-ins with the same identity yield the same user and one row', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'facebook' | 'apple'>('facebook', 'apple'),
        fc.integer({ min: 2, max: 6 }),
        socialIdentityArb('facebook'),
        socialIdentityArb('apple'),
        async (provider, repeats, fb, ap) => {
          const identity = provider === 'facebook' ? fb : ap;
          fc.pre(identity.email !== null); // no-email creation is P4's domain
          const store = new Store();
          const { service } = await buildService(store, {
            facebook: fb,
            apple: ap,
          });

          const results: AuthResponse[] = [];
          for (let i = 0; i < repeats; i++) {
            results.push(
              provider === 'facebook'
                ? await service.facebookLogin({ accessToken: 't' })
                : await service.appleLogin({ identityToken: 't' }),
            );
          }
          expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
          expect(store.rows.length).toBe(1);
          expect(store.rows[0].providerUserId).toBe(identity.providerUserId);
        },
      ),
      { numRuns: 40 },
    );
  });

  // ── P4 (Invariant): no email + unknown sub is ALWAYS 422, never 500 ──────
  it('P4: a brand-new identity without an email is always rejected with 422', async () => {
    await fc.assert(
      fc.asyncProperty(
        socialIdentityArb('facebook').map((i) => ({ ...i, email: null })),
        async (fb) => {
          const store = new Store();
          const { service, userService } = await buildService(store, {
            facebook: fb,
            apple: fb,
          });
          await expect(
            service.facebookLogin({ accessToken: 't' }),
          ).rejects.toBeInstanceOf(UnprocessableEntityException);
          expect(userService.createSocialUser).not.toHaveBeenCalled();
          expect(store.rows.length).toBe(0);
        },
      ),
      { numRuns: 40 },
    );
  });

  // ── P7 (Invariant): auto-link never rewrites the existing row ────────────
  it('P7: an existing account with the same email is reused and left untouched', async () => {
    await fc.assert(
      fc.asyncProperty(
        socialIdentityArb('apple').filter((i) => i.email !== null),
        fc.constantFrom<SocialProvider | 'local'>(
          'local',
          'google',
          'facebook',
        ),
        async (ap, existingProvider) => {
          const store = new Store();
          const existing = makeUser({
            id: 'existing',
            email: ap.email!,
            fullName: 'Existing Name',
            authProvider: existingProvider,
            providerUserId: existingProvider === 'facebook' ? 'fb-x' : null,
            password: existingProvider === 'local' ? PASSWORD_HASH : null,
          });
          store.rows.push({ ...existing });
          const { service } = await buildService(store, {
            facebook: ap,
            apple: ap,
          });

          const result = await service.appleLogin({
            identityToken: 't',
            fullName: 'Kiran Jadhav',
          });
          expect(result.user.id).toBe('existing');
          expect(store.rows.length).toBe(1);
          expect(store.rows[0]).toEqual(existing); // first provider wins
        },
      ),
      { numRuns: 40 },
    );
  });

  // ── P2 (Oracle): envelope identical to /login ─────────────────────────────
  it('P2: /auth/facebook, /auth/apple and /auth/login return structurally identical envelopes', async () => {
    await fc.assert(
      fc.asyncProperty(
        socialIdentityArb('facebook').filter((i) => i.email !== null),
        socialIdentityArb('apple').filter((i) => i.email !== null),
        async (fb, ap) => {
          const store = new Store();
          const { service, userService } = await buildService(store, {
            facebook: fb,
            apple: ap,
          });

          const fbResult = await service.facebookLogin({ accessToken: 't' });
          const apResult = await service.appleLogin({ identityToken: 't' });

          userService.findByEmailWithPassword.mockResolvedValue(
            makeUser({
              email: 'pw@example.com',
              password: PASSWORD_HASH,
              authProvider: 'local',
            }),
          );
          const loginResult = await service.login({
            email: 'pw@example.com',
            password: PASSWORD,
          });

          // Compare what the CLIENT receives (after @Exclude), as in the Google P5.
          const serialize = (u: unknown) =>
            Object.keys(
              instanceToPlain(Object.assign(new UserEntity(), u)),
            ).sort();

          for (const r of [fbResult, apResult]) {
            expect(Object.keys(r).sort()).toEqual(
              Object.keys(loginResult).sort(),
            );
            expect(serialize(r.user)).toEqual(serialize(loginResult.user));
            expect(serialize(r.user)).toEqual(
              expect.arrayContaining([
                'fullName',
                'email',
                'country',
                'countryCode',
                'zipCode',
                'createdAt',
              ]),
            );
            // providerUserId / authProvider / password never leak.
            expect(serialize(r.user)).not.toContain('providerUserId');
            expect(serialize(r.user)).not.toContain('authProvider');
            expect(serialize(r.user)).not.toContain('password');
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
