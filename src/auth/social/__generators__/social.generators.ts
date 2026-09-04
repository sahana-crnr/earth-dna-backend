// Reusable domain generators for the social sign-in property tests (PBT-07).
//
// As with the Google generators: shaped like the real thing, including the
// awkward-but-legal edges (relay emails, withheld emails, blank names), rather
// than bare fc.string() that would exercise nothing meaningful.
import fc from 'fast-check';
import type { SocialIdentity } from '../social-identity';

export const FACEBOOK_APP_ID = '1090683699976735';
export const APPLE_CLIENT_IDS = ['com.example.earthDnaApp', 'com.earthdna.app'];

/** Realistic email addresses, including Apple private relay and unicode local-parts. */
export const emailArb = fc
  .tuple(
    fc.stringMatching(/^[a-zA-Z0-9._%+-]{1,20}$/),
    fc.constantFrom(
      'example.com',
      'gmail.com',
      'earthdna.app',
      'privaterelay.appleid.com',
    ),
  )
  .map(([local, domain]) => `${local}@${domain}`.toLowerCase());

/** Names including the cases that force the local-part fallback. */
export const nameArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.constant('   '),
  fc.constantFrom('Jane Doe', 'José Álvarez', '田中 太郎', 'O’Brien', 'Kiran'),
);

/** Facebook numeric user IDs (app-scoped IDs are 15-17 digits). */
export const facebookSubArb = fc.stringMatching(/^[1-9][0-9]{14,16}$/);
/** Apple user IDs look like "001234.abcdef0123456789.5678". */
export const appleSubArb = fc.stringMatching(
  /^[0-9]{6}\.[a-f0-9]{16,32}\.[0-9]{4}$/,
);

/** Classic (opaque) Facebook tokens - never JWT-shaped. */
export const opaqueFacebookTokenArb = fc
  .stringMatching(/^EAA[A-Za-z0-9]{40,120}$/)
  .filter((t) => !t.includes('.'));

/** Something with the three-segment shape of a compact JWS. */
export const jwtShapedTokenArb = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9_-]{10,40}$/),
    fc.stringMatching(/^[A-Za-z0-9_-]{10,200}$/),
    fc.stringMatching(/^[A-Za-z0-9_-]{10,80}$/),
  )
  .map(([h, p, s]) => `${h}.${p}.${s}`);

/** A verified Limited Login payload with a valid audience. */
export const validFacebookJwtPayload = () =>
  fc.record({
    iss: fc.constant('https://www.facebook.com'),
    aud: fc.constant(FACEBOOK_APP_ID),
    sub: facebookSubArb,
    email: fc.option(emailArb, { nil: undefined }),
    name: nameArb,
    exp: fc.constant(Math.floor(Date.now() / 1000) + 3600),
  });

/** A verified Apple payload with a valid audience. */
export const validApplePayload = () =>
  fc.record({
    iss: fc.constant('https://appleid.apple.com'),
    aud: fc.constantFrom(...APPLE_CLIENT_IDS),
    sub: appleSubArb,
    email: emailArb,
    email_verified: fc.constantFrom('true', true, undefined),
    exp: fc.constant(Math.floor(Date.now() / 1000) + 3600),
  });

/** Apple payload whose aud is anything OUTSIDE our configured list. */
export const invalidAudienceApplePayload = () =>
  validApplePayload().chain((p) =>
    fc
      .string({ minLength: 1, maxLength: 60 })
      .filter((a) => !APPLE_CLIENT_IDS.includes(a))
      .map((aud) => ({ ...p, aud })),
  );

/** A Graph debug_token + /me pair that is fully valid for our app. */
export const validGraphPairArb = fc
  .tuple(facebookSubArb, fc.option(emailArb, { nil: undefined }), nameArb)
  .map(([id, email, name]) => ({
    debug: {
      data: {
        app_id: FACEBOOK_APP_ID,
        is_valid: true,
        user_id: id,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
    me: { id, name, email },
  }));

/** A complete identity as a verifier would hand to AuthService. */
export const socialIdentityArb = (
  provider: 'facebook' | 'apple',
): fc.Arbitrary<SocialIdentity> =>
  fc
    .tuple(
      provider === 'facebook' ? facebookSubArb : appleSubArb,
      fc.option(emailArb, { nil: null }),
      fc.constantFrom('Jane Doe', 'Kiran', 'jane'),
    )
    .map(([providerUserId, email, fullName]) => ({
      provider,
      providerUserId,
      email,
      fullName,
    }));
