// Properties of the F7 partial-update merge and the "enabled needs a URL" rule.
import * as fc from 'fast-check';
import {
  applyUpdate,
  incompleteReason,
  settingsEqual,
  type IntegrationPatch,
  type IntegrationSettings,
} from './integration-rules';

const maybe = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: null });
const url = fc.webUrl({ validSchemes: ['https'] });

const settings: fc.Arbitrary<IntegrationSettings> = fc.record({
  baseUrl: maybe(url),
  version: maybe(fc.string({ minLength: 1, maxLength: 64 })),
  authRef: maybe(fc.string({ minLength: 1, maxLength: 255 })),
  enabled: fc.boolean(),
});

// Each field is absent, null, or a value.
const patch: fc.Arbitrary<IntegrationPatch> = fc.record(
  {
    baseUrl: maybe(url),
    version: maybe(fc.string({ minLength: 1, maxLength: 64 })),
    authRef: maybe(fc.string({ minLength: 1, maxLength: 255 })),
    enabled: maybe(fc.boolean()),
  },
  { requiredKeys: [] },
);

describe('applyUpdate', () => {
  it('an empty patch changes nothing', () => {
    fc.assert(
      fc.property(settings, (s) => {
        expect(applyUpdate(s, {})).toEqual(s);
      }),
    );
  });

  it('absent keeps, null clears, a value replaces', () => {
    fc.assert(
      fc.property(settings, patch, (s, p) => {
        const next = applyUpdate(s, p);
        for (const k of ['baseUrl', 'version', 'authRef'] as const) {
          if (!(k in p) || p[k] === undefined) expect(next[k]).toBe(s[k]);
          else expect(next[k]).toBe(p[k]);
        }
        const e = p.enabled;
        expect(next.enabled).toBe(
          e === undefined || e === null ? s.enabled : e,
        );
      }),
    );
  });

  it('is idempotent: applying the same patch twice equals applying it once', () => {
    fc.assert(
      fc.property(settings, patch, (s, p) => {
        const once = applyUpdate(s, p);
        expect(settingsEqual(applyUpdate(once, p), once)).toBe(true);
      }),
    );
  });

  it('never mutates its input', () => {
    fc.assert(
      fc.property(settings, patch, (s, p) => {
        const copy = { ...s };
        applyUpdate(s, p);
        expect(s).toEqual(copy);
      }),
    );
  });
});

describe('incompleteReason', () => {
  it('rejects exactly "enabled without a baseUrl"', () => {
    fc.assert(
      fc.property(settings, (s) => {
        expect(incompleteReason(s) !== null).toBe(s.enabled && !s.baseUrl);
      }),
    );
  });

  it('clearing the URL of an enabled integration is rejected', () => {
    const live: IntegrationSettings = {
      baseUrl: 'https://shoedna.example.com',
      version: '1',
      authRef: null,
      enabled: true,
    };
    expect(incompleteReason(applyUpdate(live, { baseUrl: null }))).not.toBe(
      null,
    );
    expect(
      incompleteReason(applyUpdate(live, { baseUrl: null, enabled: false })),
    ).toBe(null);
  });
});
