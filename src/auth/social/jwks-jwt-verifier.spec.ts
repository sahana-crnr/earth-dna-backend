import { looksLikeJwt } from './jwks-jwt-verifier';
import { resolveFullName } from './social-identity';

describe('looksLikeJwt', () => {
  it('accepts a compact JWS (three base64url segments)', () => {
    expect(looksLikeJwt('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln')).toBe(
      true,
    );
  });

  it.each([
    ['classic Facebook token', 'EAAPfZBZAZCZBZAZCBAOZBxyz123'],
    ['two segments', 'a.b'],
    ['four segments', 'a.b.c.d'],
    ['empty segment', 'a..c'],
    ['non-base64url chars', 'a.b+c.d'],
    ['empty string', ''],
  ])('rejects %s', (_label, token) => {
    expect(looksLikeJwt(token)).toBe(false);
  });
});

describe('resolveFullName', () => {
  it('prefers the provider name, trimmed', () => {
    expect(resolveFullName('  Jane Doe ', 'x@y.com')).toBe('Jane Doe');
  });
  it('falls back to the email local-part', () => {
    expect(resolveFullName(undefined, 'jane@example.com')).toBe('jane');
    expect(resolveFullName('   ', 'jane@example.com')).toBe('jane');
  });
  it('never returns an empty string, even with no name and no email', () => {
    expect(resolveFullName(null, null).length).toBeGreaterThan(0);
    expect(resolveFullName('', '@nolocal.com').length).toBeGreaterThan(0);
  });
});
