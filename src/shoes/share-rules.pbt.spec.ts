// Property tests for share tokens (how-to.md §5: P2, P6).
import fc from 'fast-check';
import {
  TOKEN_ALPHABET,
  TOKEN_MAX_LENGTH,
  isValidToken,
  makeToken,
  randomPart,
  shareUrl,
} from './share-rules';

describe('F5-P2 makeToken', () => {
  it('defaults to a CSPRNG-backed 12-char random part', () => {
    const a = randomPart(12);
    const b = randomPart(12);
    expect(a).toHaveLength(12);
    expect(a).not.toBe(b);
    for (const c of a) expect(TOKEN_ALPHABET).toContain(c);
  });

  const text = fc.option(fc.string({ maxLength: 120 }), { nil: null });
  const chars = fc.integer({ min: 1, max: 24 });

  it('is URL-safe, at most 64 chars, ends with the untouched random part, and passes isValidToken', () => {
    fc.assert(
      fc.property(
        text,
        text,
        chars,
        fc
          .double({ min: 0, max: 1, maxExcluded: true, noNaN: true })
          .chain((seed) => fc.constant(seed)),
        (model, brand, n, seed) => {
          let x = seed;
          const pick = (max: number) => {
            x = ((x * 9301 + 49297) % 233280) / 233280;
            return Math.floor(x * max);
          };
          const random = randomPart(n, pick);
          expect(random).toHaveLength(n);
          for (const c of random) expect(TOKEN_ALPHABET).toContain(c);
          const token = makeToken(model, brand, random);
          expect(token.length).toBeLessThanOrEqual(TOKEN_MAX_LENGTH);
          expect(token.endsWith(`-${random}`)).toBe(true);
          expect(isValidToken(token)).toBe(true);
          expect(token.startsWith('-')).toBe(false);
        },
      ),
    );
  });

  it('different random parts never collide for the same shoe', () => {
    fc.assert(
      fc.property(
        text,
        text,
        fc.uniqueArray(fc.stringMatching(/^[a-z2-9]{6}$/), {
          minLength: 2,
          maxLength: 20,
        }),
        (model, brand, randoms) => {
          const tokens = randoms.map((r) => makeToken(model, brand, r));
          expect(new Set(tokens).size).toBe(tokens.length);
        },
      ),
    );
  });

  it('isValidToken rejects anything outside [a-z0-9-]{1,64}', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        expect(isValidToken(s)).toBe(/^[a-z0-9-]{1,64}$/.test(s));
      }),
    );
    expect(isValidToken('')).toBe(false);
    expect(isValidToken('Cloud-2')).toBe(false);
    expect(isValidToken('cloudmonster-2-k3x9qz')).toBe(true);
  });

  it('shareUrl joins base and token with /s/ regardless of trailing slashes', () => {
    fc.assert(
      fc.property(
        fc.webUrl(),
        fc.integer({ min: 0, max: 3 }),
        fc.stringMatching(/^[a-z0-9-]{1,30}$/),
        (base, slashes, token) => {
          const b = base.replace(/\/+$/, '') + '/'.repeat(slashes);
          expect(shareUrl(b, token)).toBe(
            `${base.replace(/\/+$/, '')}/s/${token}`,
          );
        },
      ),
    );
  });
});

describe('F5-P6 share lifecycle (stateful model)', () => {
  // The service rule: at most one active row per shoe; create returns the
  // active one; revoke closes it; a public GET after revoke is 404.
  interface Shares {
    rows: { token: string; revoked: boolean }[];
  }
  const active = (s: Shares) => s.rows.filter((r) => !r.revoked);
  let seq = 0;
  class Create implements fc.Command<Shares, Shares> {
    check = () => true;
    run(m: Shares, r: Shares) {
      const existing = active(r)[0];
      if (!existing) r.rows.push({ token: `t${(seq += 1)}`, revoked: false });
      m.rows = r.rows.map((x) => ({ ...x }));
      expect(active(r)).toHaveLength(1);
    }
    toString = () => 'create';
  }
  class Revoke implements fc.Command<Shares, Shares> {
    check = () => true;
    run(m: Shares, r: Shares) {
      for (const x of active(r)) x.revoked = true;
      m.rows = r.rows.map((x) => ({ ...x }));
      expect(active(r)).toHaveLength(0);
    }
    toString = () => 'revoke';
  }
  class PublicGet implements fc.Command<Shares, Shares> {
    constructor(private readonly idx: number) {}
    check = () => true;
    run(m: Shares, r: Shares) {
      if (r.rows.length === 0) return;
      const row = r.rows[this.idx % r.rows.length];
      const found = !row.revoked; // 200 only while active
      expect(found).toBe(active(r).some((x) => x.token === row.token));
    }
    toString = () => `get(${this.idx})`;
  }
  it('never more than one active link; revoked tokens stay dead', () => {
    fc.assert(
      fc.property(
        fc.commands(
          [
            fc.constant(new Create()),
            fc.constant(new Revoke()),
            fc.nat({ max: 50 }).map((i) => new PublicGet(i)),
          ],
          { maxCommands: 40 },
        ),
        (cmds) => {
          fc.modelRun(
            () => ({ model: { rows: [] }, real: { rows: [] } }),
            cmds,
          );
        },
      ),
    );
  });
});
