/**
 * Guards against booting with an unusable JWT signing key.
 *
 * app.config.ts falls back to the literal 'fallback-secret' when JWT_SECRET is
 * unset. Without this check a deployment that forgets the variable starts
 * normally and signs every session token with a string committed to the
 * repository - anyone could forge a token for any user, silently.
 *
 * Refusing to boot is strictly safer (SECURITY-15, fail closed): a crash with a
 * clear message is found in seconds, a forgeable token may never be noticed.
 */
export const MIN_JWT_SECRET_LENGTH = 32;
export const PLACEHOLDER_SECRET = 'fallback-secret';

export function validateJwtSecret(secret: string | undefined): void {
  if (!secret || secret === PLACEHOLDER_SECRET) {
    throw new Error(
      'JWT_SECRET is missing or still the placeholder value. ' +
        'Generate one with:\n' +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (got ${secret.length}). ` +
        'Generate one with:\n' +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
}
