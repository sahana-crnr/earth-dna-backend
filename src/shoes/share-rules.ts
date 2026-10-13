// Pure rules for public share links (F5-D14). The random part is the secret;
// the slug in front only makes the link read like the design
// (earthdna.app/s/cloudmonster-2-k3x9qz). Everything here is testable without
// a database: randomness is injected.
import { slugify } from '../catalog/catalog-rules';

/** Crockford-ish base32 without look-alikes (0/o, 1/l/i). */
export const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const TOKEN_MAX_LENGTH = 64;
export const SLUG_MAX_LENGTH = 40;
const TOKEN_RE = /^[a-z0-9-]{1,64}$/;

/** Random part: `randomChars` characters drawn from TOKEN_ALPHABET by `rnd`
 *  (0 ≤ rnd() < 1). */
export function randomPart(
  randomChars: number,
  rnd: () => number = Math.random,
): string {
  let out = '';
  for (let i = 0; i < randomChars; i += 1) {
    const idx = Math.floor(rnd() * TOKEN_ALPHABET.length);
    out += TOKEN_ALPHABET[Math.min(idx, TOKEN_ALPHABET.length - 1)];
  }
  return out;
}

/**
 * `{slug}-{random}` where slug comes from the model (fallback brand, fallback
 * "shoe"), lower-case, ≤ SLUG_MAX_LENGTH. The random part is never shortened;
 * the slug is trimmed so the whole token stays ≤ TOKEN_MAX_LENGTH.
 */
export function makeToken(
  model: string | null,
  brand: string | null,
  random: string,
): string {
  const base = slugify(model ?? '') || slugify(brand ?? '') || 'shoe';
  const room = Math.min(SLUG_MAX_LENGTH, TOKEN_MAX_LENGTH - random.length - 1);
  const slug = base.slice(0, Math.max(1, room)).replace(/-+$/, '') || 'shoe';
  return `${slug}-${random}`;
}

/** Path-parameter guard for GET /s/{token}: lower-case, digits, dashes. */
export function isValidToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

/** `${base}/s/${token}`; `base` has no trailing slash (config trims it). */
export function shareUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/s/${token}`;
}
