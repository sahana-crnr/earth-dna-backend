// Verifies Sign in with Apple identity tokens.
//
// Same shape as GoogleTokenVerifier: one injectable, security-critical component
// (SECURITY-11), substitutable in every test without network access.
//
// Apple identity tokens are RS256 JWTs signed with keys published at
// https://appleid.apple.com/auth/keys. Verification covers signature, expiry,
// iss and aud (our bundle ID). There is no secret and no key file on our side.
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwksJwtVerifier } from '../social/jwks-jwt-verifier';
import { SocialIdentity, resolveFullName } from '../social/social-identity';

export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
export const APPLE_ISSUER = 'https://appleid.apple.com';

/** Uniform message for every token-validity failure - see GoogleTokenVerifier. */
const GENERIC_REJECTION = 'Invalid Apple token';

@Injectable()
export class AppleTokenVerifier {
  private readonly logger = new Logger(AppleTokenVerifier.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jwks: JwksJwtVerifier,
  ) {}

  /**
   * @param identityToken the JWT from the app
   * @param fullNameHint  the name the app got from Apple. Apple hands the name to
   *                      the app ONLY on the very first authorization and it is
   *                      never inside the token, so the app forwards it in the body.
   */
  async verify(
    identityToken: string,
    fullNameHint?: string,
  ): Promise<SocialIdentity> {
    const clientIds = this.config.get<string[]>('apple.clientIds') ?? [];
    // Fail closed. An unset APPLE_CLIENT_IDS must never mean "any audience".
    if (clientIds.length === 0) {
      this.logger.error(
        'APPLE_CLIENT_IDS is not configured - rejecting all Apple sign-ins',
      );
      throw new UnauthorizedException('Apple sign-in is not available');
    }

    let payload: Record<string, unknown>;
    try {
      payload = await this.jwks.verify(identityToken, {
        jwksUrl: APPLE_JWKS_URL,
        issuer: APPLE_ISSUER,
        audience: clientIds,
      });
    } catch (err) {
      // Never log the token itself (SECURITY-03 / NFR-03).
      return this.reject(
        err instanceof Error ? err.message : 'verification failed',
      );
    }

    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!sub) return this.reject('payload carried no sub');

    const email =
      typeof payload.email === 'string' && payload.email.trim()
        ? payload.email.trim().toLowerCase()
        : null;

    // Apple sends email_verified as a boolean OR the string "true"/"false".
    // Only an explicit false is a rejection: absence is normal on some tokens.
    const verifiedClaim = payload.email_verified;
    if (verifiedClaim === false || verifiedClaim === 'false') {
      this.logger.warn(
        `Apple token rejected for sub ${sub}: email not verified`,
      );
      throw new UnauthorizedException('Apple account email is not verified');
    }

    return {
      provider: 'apple',
      providerUserId: sub,
      email,
      fullName: resolveFullName(fullNameHint, email),
    };
  }

  private reject(reason: string): never {
    this.logger.warn(`Apple token rejected: ${reason}`);
    throw new UnauthorizedException(GENERIC_REJECTION);
  }
}
