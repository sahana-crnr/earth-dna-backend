// Reusable domain generators for property-based tests (PBT-07).
//
// Deliberately NOT bare primitives: fc.string() for an email field produces
// garbage that no real Google token would ever contain, so the resulting tests
// pass without exercising anything meaningful. These generators produce values
// shaped like the real thing, including the awkward-but-legal edges.
import fc from 'fast-check';

export const CLIENT_IDS = [
  '440359364108-web.apps.googleusercontent.com',
  '440359364108-ios-a.apps.googleusercontent.com',
  '440359364108-ios-b.apps.googleusercontent.com',
];

/** Realistic email addresses, including unicode local-parts and long domains. */
export const emailArb = fc
  .tuple(
    fc.stringMatching(/^[a-zA-Z0-9._%+-]{1,20}$/),
    fc.constantFrom('example.com', 'gmail.com', 'earthdna.app', 'a.co.uk'),
  )
  .map(([local, domain]) => `${local}@${domain}`);

/**
 * Display names, including the cases that force the local-part fallback:
 * absent entirely, empty, and whitespace-only.
 */
export const nameArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.constant('   '),
  fc.constantFrom('Jane Doe', 'José Álvarez', '田中 太郎', 'O’Brien'),
);

/** A payload Google could plausibly return, with a valid audience. */
export const validGooglePayload = () =>
  fc.record({
    iss: fc.constantFrom('accounts.google.com', 'https://accounts.google.com'),
    aud: fc.constantFrom(...CLIENT_IDS),
    sub: fc.stringMatching(/^[0-9]{10,21}$/),
    email: emailArb,
    email_verified: fc.constant(true),
    name: nameArb,
    exp: fc.constant(Math.floor(Date.now() / 1000) + 3600),
  });

/** Same shape, but the audience is anything OUTSIDE our configured list. */
export const invalidAudiencePayload = () =>
  fc.record({
    iss: fc.constantFrom('accounts.google.com', 'https://accounts.google.com'),
    aud: fc
      .string({ minLength: 1, maxLength: 60 })
      .filter((a) => !CLIENT_IDS.includes(a)),
    sub: fc.stringMatching(/^[0-9]{10,21}$/),
    email: emailArb,
    email_verified: fc.constant(true),
    name: nameArb,
    exp: fc.constant(Math.floor(Date.now() / 1000) + 3600),
  });

/**
 * email_verified in every falsy/absent form Google could realistically produce.
 * Notably includes the STRING 'true', which is truthy in JavaScript - a strict
 * `=== true` check must still reject it.
 */
export const unverifiedEmailPayload = () =>
  fc.record({
    iss: fc.constantFrom('accounts.google.com', 'https://accounts.google.com'),
    aud: fc.constantFrom(...CLIENT_IDS),
    sub: fc.stringMatching(/^[0-9]{10,21}$/),
    email: emailArb,
    email_verified: fc.constantFrom(
      false,
      undefined,
      null,
      0,
      '',
      'true',
      'false',
      1,
    ),
    name: nameArb,
    exp: fc.constant(Math.floor(Date.now() / 1000) + 3600),
  });

/** Client ID lists for the parse round-trip property. */
export const clientIdListArb = fc.array(
  fc.stringMatching(/^[a-zA-Z0-9.-]{1,40}$/),
  { minLength: 0, maxLength: 6 },
);
