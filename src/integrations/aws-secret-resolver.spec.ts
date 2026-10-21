// The two secret shapes AwsSecretResolver accepts. The SDK call itself is not
// mocked here — the parsing is the part with decisions in it.
import { extractKey } from './aws-secret-resolver';

describe('extractKey', () => {
  it('takes a plain string secret as the key', () => {
    expect(extractKey('  sk-123 ')).toBe('sk-123');
  });

  it('takes apiKey from a JSON (console key/value) secret', () => {
    expect(extractKey('{"apiKey":"sk-456","note":"x"}')).toBe('sk-456');
  });

  it.each([
    ['empty', ''],
    ['missing', undefined],
    ['JSON without apiKey', '{"key":"sk"}'],
    ['JSON with an empty apiKey', '{"apiKey":"  "}'],
    ['malformed JSON', '{"apiKey":'],
  ])('returns null for %s', (_label, secret) => {
    expect(extractKey(secret)).toBeNull();
  });
});
