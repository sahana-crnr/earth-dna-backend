// Property-based tests for the Google sign-in unit (PBT-02..PBT-08).
//
// These COMPLEMENT the example-based tests in google-token-verifier.spec.ts and
// auth.service.spec.ts - they never replace them (PBT-10). Example tests pin
// specific known behaviour; these assert rules that must hold for every input.
//
// Shrinking is left enabled and no seed is pinned, so fast-check prints both the
// seed and the shrunk minimal counterexample on failure (PBT-08). Reproduce a
// failure with: fc.assert(prop, { seed: <printed>, path: '<printed>' })
import fc from 'fast-check';
import { instanceToPlain } from 'class-transformer';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client, type LoginTicket } from 'google-auth-library';
import { GoogleTokenVerifier } from './google-token-verifier';
import { AuthService } from '../auth.service';
import { UserService } from '../../user/user.service';
import { MailService } from '../../mail/mail.service';
import { UserEntity } from '../../user/entities/user.entity';
import { AuthResponse } from '../interfaces/auth-response.interface';
import { parseClientIds } from '../../config/google.config';
import {
  CLIENT_IDS,
  validGooglePayload,
  invalidAudiencePayload,
  unverifiedEmailPayload,
  clientIdListArb,
} from './__generators__/google.generators';

const PASSWORD = 'Password123';
/** Precomputed bcrypt hash of PASSWORD (cost 4 - test speed, not production). */
const PASSWORD_HASH =
  '$2b$04$CoCzkB81uRTf2Ka0GbBsceWQCJPmVx4Dmvja2AxIhHPwlWKd8P3d2';

/** Real library behaviour: verifyIdToken enforces `aud` itself and throws. */
function mockGoogleReturns(payload: unknown, audience: string[]) {
  const impl = (): Promise<LoginTicket> => {
    const aud = (payload as { aud?: string })?.aud;
    if (!aud || !audience.includes(aud)) {
      // Mirrors how the real library reports an audience mismatch.
      return Promise.reject(
        new Error('Wrong recipient, payload audience != requiredAudience'),
      );
    }
    // Only the getPayload() slice is ever read by the verifier.
    return Promise.resolve({
      getPayload: () => payload,
    } as unknown as LoginTicket);
  };

  return (
    jest
      .spyOn(OAuth2Client.prototype, 'verifyIdToken')
      // verifyIdToken is overloaded in google-auth-library, and jest resolves the
      // spy against the void-returning overload - so the rule flags a correctly
      // typed Promise-returning stub. impl is Promise<LoginTicket>, which is what
      // the real method returns.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      .mockImplementation(impl)
  );
}

async function buildVerifier(clientIds: string[]) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      GoogleTokenVerifier,
      {
        provide: ConfigService,
        useValue: {
          get: (k: string) =>
            k === 'google.clientIds' ? clientIds : undefined,
        },
      },
    ],
  }).compile();
  module.useLogger(false);
  return module.get(GoogleTokenVerifier);
}

describe('google-signin properties', () => {
  afterEach(() => jest.restoreAllMocks());

  // ── P1 (Invariant) ────────────────────────────────────────────────────────
  it('P1: NO payload with email_verified !== true is ever accepted', async () => {
    const verifier = await buildVerifier(CLIENT_IDS);

    await fc.assert(
      fc.asyncProperty(unverifiedEmailPayload(), async (payload) => {
        mockGoogleReturns(payload, CLIENT_IDS);
        // Must reject for EVERY falsy form - including the string 'true',
        // which a loose truthiness check would wrongly let through.
        await expect(verifier.verify('token')).rejects.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  // ── P2 (Invariant) ────────────────────────────────────────────────────────
  it('P2: NO payload whose aud is outside the configured list is accepted', async () => {
    const verifier = await buildVerifier(CLIENT_IDS);

    await fc.assert(
      fc.asyncProperty(invalidAudiencePayload(), async (payload) => {
        mockGoogleReturns(payload, CLIENT_IDS);
        await expect(verifier.verify('token')).rejects.toThrow(
          'Invalid Google token',
        );
      }),
      { numRuns: 100 },
    );
  });

  it('P2b: an EMPTY client ID list rejects every otherwise-valid payload', async () => {
    const verifier = await buildVerifier([]);

    await fc.assert(
      fc.asyncProperty(validGooglePayload(), async (payload) => {
        const spy = mockGoogleReturns(payload, CLIENT_IDS);
        await expect(verifier.verify('token')).rejects.toThrow(
          'Google sign-in is not available',
        );
        // Fail closed: the library must never be reached with no audience.
        expect(spy).not.toHaveBeenCalled();
      }),
      { numRuns: 50 },
    );
  });

  it('accepts every valid payload, and always produces a non-empty fullName', async () => {
    const verifier = await buildVerifier(CLIENT_IDS);

    await fc.assert(
      fc.asyncProperty(validGooglePayload(), async (payload) => {
        mockGoogleReturns(payload, CLIENT_IDS);
        const identity = await verifier.verify('token');

        expect(identity.email).toBe(payload.email);
        expect(identity.emailVerified).toBe(true);
        // The local-part fallback must cover absent / empty / whitespace names.
        expect(identity.fullName.trim().length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  // ── P6 (Round-trip) ───────────────────────────────────────────────────────
  it('P6: parseClientIds(join(ids)) === ids, tolerating messy input', () => {
    fc.assert(
      fc.property(clientIdListArb, (ids) => {
        expect(parseClientIds(ids.join(','))).toEqual(ids);
        // Padding, trailing commas and doubled separators must all survive.
        expect(parseClientIds(ids.map((i) => `  ${i}  `).join(','))).toEqual(
          ids,
        );
        expect(parseClientIds(ids.join(',') + ',')).toEqual(ids);
        expect(parseClientIds(ids.join(',,'))).toEqual(ids);
      }),
      { numRuns: 200 },
    );
  });

  it('P6b: absent or blank config parses to an empty list, never to a falsy match', () => {
    expect(parseClientIds(undefined)).toEqual([]);
    expect(parseClientIds('')).toEqual([]);
    expect(parseClientIds('   ')).toEqual([]);
    expect(parseClientIds(',,,')).toEqual([]);
  });
});

// ── Service-level properties: P3, P4, P5 ────────────────────────────────────
describe('googleLogin properties', () => {
  function makeUser(email: string, over: Partial<UserEntity> = {}): UserEntity {
    return {
      id: 'user-uuid',
      fullName: 'Jane Doe',
      email,
      password: null,
      resetPasswordToken: null,
      resetPasswordExpiry: null,
      country: null,
      countryCode: null,
      zipCode: null,
      authProvider: 'google',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
  }

  async function buildService(store: Map<string, UserEntity>) {
    const userService = {
      findByEmail: jest.fn((e: string) =>
        Promise.resolve(store.get(e) ?? null),
      ),
      findByEmailWithPassword: jest.fn((e: string) =>
        Promise.resolve(store.get(e) ?? null),
      ),
      createGoogleUser: jest.fn(
        (params: { email: string; fullName: string }) => {
          // Mirrors the real unique-constraint behaviour: one row per email.
          const existing = store.get(params.email);
          if (existing) return Promise.resolve(existing);
          const created = makeUser(params.email, {
            fullName: params.fullName,
            id: `id-${store.size}`,
          });
          store.set(params.email, created);
          return Promise.resolve(created);
        },
      ),
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
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: GoogleTokenVerifier,
          useValue: {
            verify: jest.fn(() =>
              Promise.resolve({
                email: 'jane@example.com',
                fullName: 'Jane Doe',
                emailVerified: true as const,
              }),
            ),
          },
        },
      ],
    }).compile();
    module.useLogger(false);
    return { service: module.get(AuthService), userService };
  }

  // ── P4 (Idempotence) ──────────────────────────────────────────────────────
  it('P4: verifying the same token twice yields the same user and ONE row', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (repeats) => {
        const store = new Map<string, UserEntity>();
        const { service } = await buildService(store);

        const results: AuthResponse[] = [];
        for (let i = 0; i < repeats; i++) {
          results.push(await service.googleLogin({ idToken: 'same-token' }));
        }

        // f(f(x)) === f(x): every call returns the same identity...
        const ids = new Set(results.map((r) => r.user.id));
        expect(ids.size).toBe(1);
        // ...and no repeat created an extra account.
        expect(store.size).toBe(1);
      }),
      { numRuns: 30 },
    );
  });

  // ── P3 (Invariant) ────────────────────────────────────────────────────────
  it('P3: the response never carries password or authProvider', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const store = new Map<string, UserEntity>();
        const { service } = await buildService(store);
        const result = await service.googleLogin({ idToken: 'token' });

        // instanceToPlain applies the @Exclude() decorators exactly as the
        // global ClassSerializerInterceptor does on a real response.
        const serialized = instanceToPlain(
          Object.assign(new UserEntity(), result.user),
        );
        expect(serialized).not.toHaveProperty('password');
        expect(serialized).not.toHaveProperty('authProvider');
        expect(serialized).not.toHaveProperty('resetPasswordToken');
      }),
      { numRuns: 20 },
    );
  });

  // ── P5 (Oracle) ───────────────────────────────────────────────────────────
  it('P5: /auth/google and /auth/login return structurally identical envelopes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const store = new Map<string, UserEntity>();
        const { service, userService } = await buildService(store);

        const googleResult = await service.googleLogin({ idToken: 'token' });

        // Oracle: the existing /login flow is the reference implementation.
        // Precomputed bcrypt hash of PASSWORD - the service still runs the real
        // bcrypt.compare against it, we just avoid hashing on every run.
        userService.findByEmailWithPassword.mockResolvedValue(
          makeUser('pw@example.com', {
            password: PASSWORD_HASH,
            authProvider: 'local',
          }),
        );
        const loginResult = await service.login({
          email: 'pw@example.com',
          password: PASSWORD,
        });

        // Compare what the CLIENT actually receives, not the raw service return.
        //
        // This distinction is not cosmetic - this property originally failed and
        // was right to: /login does `delete user.password`, so the key is absent,
        // while createGoogleUser sets `password: null`, so the key is present.
        // The raw returns genuinely differ. The global ClassSerializerInterceptor
        // applies @Exclude() to both before they leave the process, so the two
        // HTTP responses ARE identical - and the HTTP response is what the brief
        // promises. Serializing here mirrors the real request path.
        const serialize = (u: unknown) =>
          Object.keys(
            instanceToPlain(Object.assign(new UserEntity(), u)),
          ).sort();

        // This is the brief's promise - "so the app doesn't need special-case
        // handling" - expressed as an executable assertion.
        expect(Object.keys(googleResult).sort()).toEqual(
          Object.keys(loginResult).sort(),
        );
        expect(serialize(googleResult.user)).toEqual(
          serialize(loginResult.user),
        );
        // And the promised fields are all actually present.
        expect(serialize(googleResult.user)).toEqual(
          expect.arrayContaining([
            'fullName',
            'email',
            'country',
            'countryCode',
            'zipCode',
            'createdAt',
          ]),
        );
      }),
      { numRuns: 20 },
    );
  });
});
