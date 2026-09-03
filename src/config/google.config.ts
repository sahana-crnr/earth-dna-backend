// Google Sign-In config. GOOGLE_CLIENT_IDS is the list of OAuth client IDs the
// backend will accept as the "aud" claim of an incoming Google ID token.
//
// An empty list is NOT treated as "accept anything" - GoogleTokenVerifier fails
// closed and rejects every token. A forgotten environment variable must never
// become an open door.
import { registerAs } from '@nestjs/config';

export default registerAs('google', () => ({
  clientIds: parseClientIds(process.env.GOOGLE_CLIENT_IDS),
}));

/**
 * Splits a comma-separated client ID list, tolerating whitespace and empty
 * segments (trailing commas, accidental double commas, values wrapped across
 * lines in a .env file).
 */
export function parseClientIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
