// Verifies Facebook Login tokens. Dual-path, because the app sends a different
// kind of token per platform in the same `accessToken` field:
//
//   iOS     - Limited Login OIDC token: an RS256 JWT signed with keys published at
//             https://www.facebook.com/.well-known/oauth/openid/jwks/. Verified
//             offline: signature, exp, iss, aud (= our App ID). Identity claims
//             (sub, email, name) are inside the token.
//   Android - classic access token: an opaque string (starts "EAA"). Cannot be
//             verified offline. We ask Graph API:
//               1. debug_token with the APP access token (APP_ID|APP_SECRET) ->
//                  must be is_valid and issued for OUR app_id
//               2. /me?fields=id,name,email with appsecret_proof -> identity
//
// The path is chosen by shape (three base64url segments = JWT). Both paths end
// in the same SocialIdentity, so AuthService has no idea which one ran.
//
// Isolated in one injectable (SECURITY-11), substitutable in tests.
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { JwksJwtVerifier, looksLikeJwt } from '../social/jwks-jwt-verifier';
import { SocialIdentity, resolveFullName } from '../social/social-identity';

export const FACEBOOK_JWKS_URL =
  'https://www.facebook.com/.well-known/oauth/openid/jwks/';
export const FACEBOOK_ISSUER = 'https://www.facebook.com';
export const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com';
/** Pinned so a Graph API version deprecation is a deliberate change, not a surprise. */
export const FACEBOOK_GRAPH_VERSION = 'v21.0';

/** How long each Graph API call may take. Two calls per opaque-token sign-in. */
const GRAPH_TIMEOUT_MS = 5000;

const GENERIC_REJECTION = 'Invalid Facebook token';

interface DebugTokenResponse {
  data?: {
    app_id?: string;
    is_valid?: boolean;
    user_id?: string;
    expires_at?: number;
    error?: { message?: string };
  };
  error?: { message?: string };
}

interface MeResponse {
  id?: string;
  name?: string;
  email?: string;
  error?: { message?: string };
}

@Injectable()
export class FacebookTokenVerifier {
  private readonly logger = new Logger(FacebookTokenVerifier.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jwks: JwksJwtVerifier,
  ) {}

  async verify(accessToken: string): Promise<SocialIdentity> {
    const appId = this.config.get<string>('facebook.appId') ?? '';
    // Fail closed on both paths: without an App ID there is no audience to
    // check a JWT against and no app to compare debug_token's app_id with.
    if (!appId) {
      this.logger.error(
        'FACEBOOK_APP_ID is not configured - rejecting all Facebook sign-ins',
      );
      throw new UnauthorizedException('Facebook sign-in is not available');
    }

    return looksLikeJwt(accessToken)
      ? this.verifyLimitedLoginJwt(accessToken, appId)
      : this.verifyClassicToken(accessToken, appId);
  }

  // ── iOS: Limited Login OIDC JWT ───────────────────────────────────────────
  private async verifyLimitedLoginJwt(
    token: string,
    appId: string,
  ): Promise<SocialIdentity> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwks.verify(token, {
        jwksUrl: FACEBOOK_JWKS_URL,
        issuer: FACEBOOK_ISSUER,
        audience: appId,
      });
    } catch (err) {
      // Never log the token itself (SECURITY-03 / NFR-03).
      return this.reject(
        `jwt: ${err instanceof Error ? err.message : 'verification failed'}`,
      );
    }

    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!sub) return this.reject('jwt: payload carried no sub');

    const email = FacebookTokenVerifier.normaliseEmail(payload.email);
    const name =
      typeof payload.name === 'string'
        ? payload.name
        : [payload.given_name, payload.family_name]
            .filter((p): p is string => typeof p === 'string')
            .join(' ');

    return {
      provider: 'facebook',
      providerUserId: sub,
      email,
      fullName: resolveFullName(name, email),
    };
  }

  // ── Android: classic opaque access token ──────────────────────────────────
  private async verifyClassicToken(
    token: string,
    appId: string,
  ): Promise<SocialIdentity> {
    const appSecret = this.config.get<string>('facebook.appSecret') ?? '';
    // Only this path needs the secret. Fail closed here without taking the
    // iOS JWT path down with it.
    if (!appSecret) {
      this.logger.error(
        'FACEBOOK_APP_SECRET is not configured - rejecting classic Facebook tokens',
      );
      throw new UnauthorizedException('Facebook sign-in is not available');
    }

    // 1. Is this token genuine, live, and minted for OUR app?
    const debug = await this.graphGet<DebugTokenResponse>('/debug_token', {
      input_token: token,
      access_token: `${appId}|${appSecret}`,
    });
    if (!debug || debug.error || !debug.data) {
      return this.reject(
        `debug_token: ${debug?.error?.message ?? 'no data in response'}`,
      );
    }
    if (debug.data.is_valid !== true) {
      return this.reject(
        `debug_token: is_valid=false (${debug.data.error?.message ?? 'no reason'})`,
      );
    }
    if (debug.data.app_id !== appId) {
      return this.reject(
        `debug_token: token issued for app ${debug.data.app_id ?? '?'}, not ours`,
      );
    }
    if (
      typeof debug.data.expires_at === 'number' &&
      debug.data.expires_at !== 0 && // 0 = never expires (long-lived tokens)
      debug.data.expires_at * 1000 <= Date.now()
    ) {
      return this.reject('debug_token: token expired');
    }

    // 2. Who is it? appsecret_proof binds this call to our app secret so a
    //    leaked user token alone cannot be replayed against our app's Graph
    //    calls once "Require App Secret" is switched on in the Meta console.
    const proof = crypto
      .createHmac('sha256', appSecret)
      .update(token)
      .digest('hex');
    const me = await this.graphGet<MeResponse>(
      `/${FACEBOOK_GRAPH_VERSION}/me`,
      { fields: 'id,name,email', access_token: token, appsecret_proof: proof },
    );
    if (!me || me.error || !me.id) {
      return this.reject(`me: ${me?.error?.message ?? 'no id in response'}`);
    }
    if (debug.data.user_id && me.id !== debug.data.user_id) {
      return this.reject('me: user_id does not match debug_token');
    }

    const email = FacebookTokenVerifier.normaliseEmail(me.email);
    return {
      provider: 'facebook',
      providerUserId: me.id,
      email,
      fullName: resolveFullName(me.name, email),
    };
  }

  /** GET on Graph API with a hard timeout. Null on any transport failure. */
  private async graphGet<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T | null> {
    const url = new URL(path, FACEBOOK_GRAPH_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
      // Graph returns 400 with an error body for a bad token - still JSON, and
      // the caller wants to see the error message, so do not throw on !ok.
      return (await res.json()) as T;
    } catch (err) {
      // The token is in the URL: log the path only.
      this.logger.warn(
        `Graph API ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private static normaliseEmail(value: unknown): string | null {
    return typeof value === 'string' && value.trim()
      ? value.trim().toLowerCase()
      : null;
  }

  /** Logs the real reason server-side, returns the generic message to the caller. */
  private reject(reason: string): never {
    this.logger.warn(`Facebook token rejected: ${reason}`);
    throw new UnauthorizedException(GENERIC_REJECTION);
  }
}
