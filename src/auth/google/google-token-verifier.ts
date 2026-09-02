// Verifies Google ID tokens.
//
// Isolated in its own injectable provider for two reasons: it is the one
// security-critical component of the Google sign-in flow (SECURITY-11 - keep such
// logic in a dedicated module), and every test can substitute it without needing
// network access or a real Google token.
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { GoogleIdentity } from './google-identity';

/** Google's two accepted issuer spellings. */
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Deliberately uniform message for every token-validity failure.
 *
 * Telling a caller "expired" versus "wrong audience" tells someone probing the
 * endpoint exactly which part of a forged token to adjust. The specific reason is
 * logged server-side instead, so debugging loses nothing.
 */
const GENERIC_REJECTION = 'Invalid Google token';

@Injectable()
export class GoogleTokenVerifier {
  private readonly logger = new Logger(GoogleTokenVerifier.name);

  // One long-lived client. google-auth-library caches Google's public keys (JWKS)
  // on the instance, honouring their cache headers - constructing a new client per
  // request would throw that cache away and refetch the keys every time.
  private readonly client = new OAuth2Client();

  constructor(private readonly config: ConfigService) {}

  async verify(idToken: string): Promise<GoogleIdentity> {
    const clientIds = this.config.get<string[]>('google.clientIds') ?? [];

    // Fail closed. An unset GOOGLE_CLIENT_IDS must never be interpreted as
    // "any audience is acceptable" - we never reach verifyIdToken to find out
    // what an empty audience array would do.
    if (clientIds.length === 0) {
      this.logger.error(
        'GOOGLE_CLIENT_IDS is not configured - rejecting all Google sign-ins',
      );
      throw new UnauthorizedException('Google sign-in is not available');
    }

    let payload: TokenPayload | undefined;
    try {
      // Checks the signature against Google's published keys, the expiry, and
      // that "aud" matches one of our client IDs - all in this one call.
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: clientIds,
      });
      payload = ticket.getPayload();
    } catch (err) {
      // Never log idToken itself (SECURITY-03 / NFR-03).
      this.reject(err instanceof Error ? err.message : 'verification failed');
    }

    if (!payload) {
      this.reject('token carried no payload');
    }

    if (!GOOGLE_ISSUERS.includes(payload.iss)) {
      this.reject(`unexpected issuer: ${payload.iss}`);
    }

    if (!payload.email) {
      this.reject('payload carried no email');
    }

    // Google can issue tokens for accounts whose email is unverified. Accepting
    // those while also linking accounts by email would let someone who controls an
    // unverified Google account claiming a victim's address take over the victim's
    // existing account.
    //
    // This failure gets its own message: it is actionable by a legitimate user and
    // leaks nothing, since they already control the account in question.
    if (payload.email_verified !== true) {
      this.logger.warn(
        `Google token rejected for ${payload.email}: email not verified`,
      );
      throw new UnauthorizedException('Google account email is not verified');
    }

    return {
      email: payload.email,
      // "name" is not guaranteed on every Google token. Falling back to the email
      // local-part keeps fullName populated rather than storing an empty string.
      fullName: payload.name?.trim() || payload.email.split('@')[0],
      emailVerified: true,
    };
  }

  /** Logs the real reason server-side, returns the generic message to the caller. */
  private reject(reason: string): never {
    this.logger.warn(`Google token rejected: ${reason}`);
    throw new UnauthorizedException(GENERIC_REJECTION);
  }
}
